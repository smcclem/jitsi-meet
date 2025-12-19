import { connect } from 'react-redux';
import { createToolbarEvent } from '../../analytics/AnalyticsEvents';
import { sendAnalytics } from '../../analytics/functions';
import { IReduxState } from '../../app/types';
import { translate } from '../../base/i18n/functions';
import { IconSerialPort } from '../../base/icons/svg';
import AbstractButton, { IProps as AbstractButtonProps } from '../../base/toolbox/components/AbstractButton';
import { isMobileBrowser } from '../../base/environment/utils';
import { isVpaasMeeting } from '../../jaas/functions';

interface NavigatorWithSerial extends Navigator {
    serial: {
        requestPort: () => Promise<SerialPortExtended>;
    };
}

interface SerialPortExtended {
    readable: ReadableStream<Uint8Array>;
    writable: WritableStream<Uint8Array>;
    open(options: {
        baudRate: number;
        parity?: 'none' | 'even' | 'odd';
        dataBits?: 7 | 8;
        stopBits?: 1 | 1.5 | 2;
        bufferSize?: number;
        flowControl?: 'none' | 'hardware';
    }): Promise<void>;
    close(): Promise<void>;
    setSignals(signals: {
        dataTerminalReady?: boolean;
        requestToSend?: boolean;
    }): Promise<void>;
    getSignals(): Promise<{
        clearToSend?: boolean;
    }>;
}

class SerialPortButton extends AbstractButton<AbstractButtonProps> {
    accessibilityLabel = 'toolbar.accessibilityLabel.serialPort';
    icon = IconSerialPort;
    label = 'toolbar.serialPort';
    tooltip = 'toolbar.serialPort';

    port: SerialPortExtended | null = null;
    writer: WritableStreamDefaultWriter<Uint8Array> | null = null;
    reader: ReadableStreamDefaultReader<string> | null = null;
    socket: WebSocket | null = null;

    private clientIp: string | null = null;

    private shutdownRequested = false;

    private pingTimer: ReturnType<typeof setInterval> | null = null;
    private pongCheck: ReturnType<typeof setInterval> | null = null;

    private psInterval: ReturnType<typeof setInterval> | null = null;
    private psTimeoutTimer: ReturnType<typeof setTimeout> | null = null;
    private psAwaiting = false;
    private psScanBuf = '';

    private signalPollTimer: ReturnType<typeof setInterval> | null = null;
    private lastCTS: boolean | undefined;

    private static readonly ONE_MIB = 1024 * 1024;
    private static readonly PS_POLL_MS = 5_000;
    private static readonly PS_TIMEOUT_MS = 2_000;
    private static readonly PTT_POLL_MS = 100;

    _handleClick() {
        this.connectSerialPort();
        sendAnalytics(createToolbarEvent('serial.port'));
    }

    private async getClientIP(): Promise<string> {
        if (this.clientIp) {
            return this.clientIp;
        }

        const resp = await fetch('https://api.ipify.org?format=json');

        if (!resp.ok) {
            throw new Error(`IP fetch failed: ${resp.status}`);
        }

        const { ip } = await resp.json() as { ip: string; };

        this.clientIp = ip;

        return ip;
    }

    async connectSerialPort() {
        try {
            // Reset shutdown on manual connect.
            this.shutdownRequested = false;

            // If already connected, reset first.
            await this.disconnect();

            // 1) get public IP.
            const clientIp = await this.getClientIP();

            // 2) ask for a port
            const nav = navigator as unknown as NavigatorWithSerial;
            this.port = await nav.serial.requestPort();

            // 3) open with extra options
            await this.port.open({
                baudRate: 38400,
                parity: 'none',
                dataBits: 8,
                stopBits: 1,
                bufferSize: SerialPortButton.ONE_MIB,
                flowControl: 'none'
            });
            // force DTR/RTS low
            await this.port.setSignals({ dataTerminalReady: false, requestToSend: false });

            // 4) start text decoding
            const textDecoder = new TextDecoderStream();
            // catch pipe errors
            (this.port.readable as unknown as ReadableStream<BufferSource>)
                .pipeTo(textDecoder.writable)
                .catch(e => console.error('Pipe error:', e));

            this.reader = textDecoder.readable.getReader();
            this.writer = this.port.writable.getWriter();

            // 5) start the WS using the client IP
            this.initializeWebSocket(clientIp);

            // 6) pump serial→WS
            this.readLoop().catch(e =>
                console.error('ReadLoop error:', e)
            );

            // 7) Start periodic serial polling (PS;).
            this.startPsPolling();

            // 8) Start PTT (CTS) monitor.
            this.startSignalMonitor();
        } catch (e) {
            console.error('Connection error:', e);
        }
    }

    initializeWebSocket(clientIp: string) {
        // Clean up any existing socket + heartbeat timers.
        if (this.socket) {
            this.socket.onopen = null;
            this.socket.onmessage = null;
            this.socket.onerror = null;
            this.socket.onclose = null;

            this.stopHeartbeat();

            if (this.socket.readyState !== WebSocket.CLOSED) {
                try {
                    this.socket.close();
                } catch (_) {
                    // ignore
                }
            }
        }

        const url = `wss://station.wu2x.com:8443/webRRL/websocket2?clientIp=${encodeURIComponent(clientIp)}`;

        this.socket = new WebSocket(url);

        let lastPong = Date.now();

        this.socket.addEventListener('open', () => {
            lastPong = Date.now();
            this.startHeartbeat(() => lastPong, (t: number) => {
                lastPong = t;
            });
        });

        this.socket.addEventListener('message', async event => {
            // heartbeat
            if (typeof event.data === 'string') {
                try {
                    const msg = JSON.parse(event.data) as { type?: string; };
                    if (msg.type === 'pong') {
                        lastPong = Date.now();
                        return;
                    }
                } catch (_) {
                    // not JSON
                }

                await this.writeData(event.data);
            } else if (event.data instanceof Blob) {
                const text = await event.data.text();

                await this.writeData(text);
            }
        });

        this.socket.addEventListener('error', () => {
            // let onclose handle reconnect
        });

        this.socket.addEventListener('close', () => {
            this.stopHeartbeat();
            this.scheduleReconnect();
        });
    }

    private startHeartbeat(getLastPong: () => number, setLastPong: (t: number) => void) {
        this.stopHeartbeat();

        // send a ping every 25s
        this.pingTimer = setInterval(() => {
            if (!this.socket || this.shutdownRequested || this.socket.readyState !== WebSocket.OPEN) {
                return;
            }
            try {
                this.socket.send(JSON.stringify({ type: 'ping', t: Date.now() }));
            } catch (_) {
                // ignore transient errors
            }
        }, 25_000);

        // check every 5s whether pong is stale (>35s)
        this.pongCheck = setInterval(() => {
            if (this.shutdownRequested) {
                return;
            }
            if (Date.now() - getLastPong() > 35_000) {
                try {
                    this.socket?.close();
                } catch (_) {
                    // ignore
                }
            }
        }, 5_000);

        setLastPong(Date.now());
    }

    private stopHeartbeat() {
        if (this.pingTimer) {
            clearInterval(this.pingTimer);
            this.pingTimer = null;
        }
        if (this.pongCheck) {
            clearInterval(this.pongCheck);
            this.pongCheck = null;
        }
    }

    private scheduleReconnect() {
        if (this.shutdownRequested) {
            return;
        }

        if (this.socket && this.socket.readyState !== WebSocket.CLOSED) {
            try {
                this.socket.close();
            } catch (_) {
                // ignore
            }
        }

        // break recursion with a small delay
        setTimeout(() => {
            if (this.shutdownRequested || !this.clientIp) {
                return;
            }
            this.initializeWebSocket(this.clientIp);
        }, 100);
    }

    private async readLoop() {
        while (this.reader) {
            const { value, done } = await this.reader.read();
            if (done) {
                break;
            }
            if (value) {
                // scan for PS replies in serial stream
                this.psScanBuf += value;
                if (this.psScanBuf.length > 2048) {
                    this.psScanBuf = this.psScanBuf.slice(-1024);
                }
                if (this.psAwaiting && /PS[^;]*;/.test(this.psScanBuf)) {
                    this.psAwaiting = false;
                    if (this.psTimeoutTimer) {
                        clearTimeout(this.psTimeoutTimer);
                        this.psTimeoutTimer = null;
                    }
                }

                if (this.socket?.readyState === WebSocket.OPEN) {
                    try {
                        this.socket.send(value);
                    } catch (_) {
                        // ignore transient errors
                    }
                }
            }
        }
    }

    async writeData(data: string) {
        if (!this.writer) {
            return;
        }
        const enc = new TextEncoder();
        await this.writer.write(enc.encode(data));
    }

    private startSignalMonitor() {
        this.stopSignalMonitor();

        this.signalPollTimer = setInterval(async () => {
            if (this.shutdownRequested || !this.port) {
                return;
            }

            try {
                const sig = await this.port.getSignals();
                const cts = Boolean(sig.clearToSend);

                if (cts !== this.lastCTS) {
                    this.lastCTS = cts;
                    if (this.socket?.readyState === WebSocket.OPEN) {
                        try {
                            this.socket.send(cts ? 'TX;' : 'RX;');
                        } catch (_) {
                            // ignore
                        }
                    }
                }
            } catch (_) {
                this.stopSignalMonitor();
            }
        }, SerialPortButton.PTT_POLL_MS);
    }

    private stopSignalMonitor() {
        if (this.signalPollTimer) {
            clearInterval(this.signalPollTimer);
            this.signalPollTimer = null;
        }
        this.lastCTS = undefined;
    }

    private startPsPolling() {
        this.stopPsPolling();

        // fire one immediately so logic is exercised on connect
        this.issuePsPoll();
        this.psInterval = setInterval(() => this.issuePsPoll(), SerialPortButton.PS_POLL_MS);
    }

    private stopPsPolling() {
        if (this.psInterval) {
            clearInterval(this.psInterval);
            this.psInterval = null;
        }
        if (this.psTimeoutTimer) {
            clearTimeout(this.psTimeoutTimer);
            this.psTimeoutTimer = null;
        }
        this.psAwaiting = false;
    }

    private issuePsPoll() {
        if (!this.writer || this.shutdownRequested) {
            return;
        }

        try {
            void this.writeData('PS;');
        } catch (_) {
            // ignore
        }

        this.psAwaiting = true;
        if (this.psTimeoutTimer) {
            clearTimeout(this.psTimeoutTimer);
            this.psTimeoutTimer = null;
        }

        this.psTimeoutTimer = setTimeout(() => {
            if (!this.psAwaiting) {
                return;
            }
            this.psAwaiting = false;

            // shutdown everything, no reconnect
            this.shutdownRequested = true;
            this.stopPsPolling();
            this.stopSignalMonitor();
            void this.disconnect();
        }, SerialPortButton.PS_TIMEOUT_MS);
    }

    componentWillUnmount() {
        this.shutdownRequested = true;
        void this.disconnect();
    }

    private async disconnect() {
        this.stopPsPolling();
        this.stopSignalMonitor();
        this.stopHeartbeat();

        if (this.reader) {
            try {
                await this.reader.cancel();
            } catch (_) {
                // ignore
            }
            try {
                this.reader.releaseLock();
            } catch (_) {
                // ignore
            }
            this.reader = null;
        }
        if (this.writer) {
            try {
                await this.writer.close();
            } catch (_) {
                // ignore
            }
            try {
                this.writer.releaseLock();
            } catch (_) {
                // ignore
            }
            this.writer = null;
        }
        if (this.port) {
            try {
                await this.port.close();
            } catch (_) {
                // ignore
            }
            this.port = null;
        }
        if (this.socket) {
            try {
                this.socket.close();
            } catch (_) {
                // ignore
            }
            this.socket = null;
        }
    }

    render() {
        // we still just render the toolbar button
        return super.render();
    }
}

const mapStateToProps = (state: IReduxState) => ({
    visible: !isVpaasMeeting(state) && !isMobileBrowser() && 'serial' in navigator
});

export default translate(connect(mapStateToProps)(SerialPortButton));