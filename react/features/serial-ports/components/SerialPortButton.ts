import React from 'react';
import { connect } from 'react-redux';
import { createToolbarEvent } from '../../analytics/AnalyticsEvents';
import { sendAnalytics } from '../../analytics/functions';
import { IReduxState } from '../../app/types';
import { translate } from '../../base/i18n/functions';
import { IconSerialPort } from '../../base/icons/svg';
import AbstractButton, { IProps as AbstractButtonProps } from '../../base/toolbox/components/AbstractButton';
import { isMobileBrowser } from '../../base/environment/utils';
import { isVpaasMeeting } from '../../jaas/functions';
import { showWarningNotification } from '../../notifications/actions';
import { showSuccessNotification } from '../../notifications/actions';
import { showNotification } from '../../notifications/actions';
import { NOTIFICATION_TIMEOUT_TYPE } from '../../notifications/constants';
import { NOTIFICATION_TYPE } from '../../notifications/constants';
import { setSerialPortConnected, setSerialPortStatus } from '../actions';
import SerialConnectionLed from './SerialConnectionLed';

const SERIAL_TRACE = true;

function _trace(prefix: string, message: string, extra?: any) {
    if (!SERIAL_TRACE) {
        return;
    }

    // Keep output human-friendly and grep-able.
    // eslint-disable-next-line no-console
    console.log(`[serial][${prefix}] ${message}`, extra ?? '');
}

interface IProps extends AbstractButtonProps {
    serialConnected?: boolean;
    serialStatus?: string;
}

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

class SerialPortButton extends AbstractButton<IProps> {
    override accessibilityLabel = 'toolbar.accessibilityLabel.serialPort';
    override icon = IconSerialPort;
    override label = 'toolbar.serialPort';
    override tooltip = 'toolbar.serialPort';

    port: SerialPortExtended | null = null;
    writer: WritableStreamDefaultWriter<Uint8Array> | null = null;
    reader: ReadableStreamDefaultReader<string> | null = null;
    socket: WebSocket | null = null;

    private decodeAbortController: AbortController | null = null;
    private decodePipe: Promise<void> | null = null;

    private clientIp: string | null = null;

    private shutdownRequested = false;

    // When we intentionally close the socket as part of a local reset (e.g. during connect),
    // we must suppress the close handler from scheduling an auto-reconnect.
    private suppressNextSocketCloseEffects = false;

    private pingTimer: ReturnType<typeof setInterval> | null = null;
    private pongCheck: ReturnType<typeof setInterval> | null = null;

    private wsUnavailableNotified = false;
    private reconnectRequested = false;

    private psInterval: ReturnType<typeof setInterval> | null = null;
    private psTimeoutTimer: ReturnType<typeof setTimeout> | null = null;
    private psAwaiting = false;
    private psScanBuf = '';

    private signalPollTimer: ReturnType<typeof setInterval> | null = null;
    private lastCTS: boolean | undefined;
    private signalPollInFlight = false;

    private serialWriteChain: Promise<void> = Promise.resolve();

    private static readonly RADIO_ID = 'k3Radio1';

    private static activeInstance: SerialPortButton | null = null;

    private lastConnected = false;

    private static readonly ONE_MIB = 1024 * 1024;
    private static readonly PS_POLL_MS = 5_000;
    private static readonly PS_TIMEOUT_MS = 2_000;
    private static readonly PTT_POLL_MS = 100;

    override _handleClick() {
        _trace(SerialPortButton.RADIO_ID, `_handleClick: serialConnected=${String(Boolean(this.props.serialConnected))}`);
        if (this.props.serialConnected) {
            // Treat second click as a manual disconnect.
            // The overflow menu can remount this component; disconnect the currently active instance.
            const active = SerialPortButton.activeInstance ?? this;

            active.shutdownRequested = true;
            _trace(SerialPortButton.RADIO_ID, 'manual disconnect requested', {
                activeIsThis: active === this
            });

            void active.disconnect();

            return;
        }

        this.connectSerialPort();
        sendAnalytics(createToolbarEvent('serial.port'));
    }

    override _getElementAfter() {
        // Only show the LED in overflow/context menu rendering.
        if (!this.props.showLabel) {
            return null;
        }

        const status = this.props.serialStatus;
        if (status === 'connected') {
            return React.createElement(SerialConnectionLed, { status: 'connected' });
        }
        if (status === 'connecting' || status === 'reconnecting') {
            return React.createElement(SerialConnectionLed, { status: 'warning' });
        }

        return null;
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
            _trace(SerialPortButton.RADIO_ID, 'connectSerialPort: start', {
                hasPort: Boolean(this.port),
                hasSocket: Boolean(this.socket),
                shutdownRequested: this.shutdownRequested,
                activeIsThis: SerialPortButton.activeInstance === this
            });
            // Closing/reopening the overflow menu can create multiple instances; make sure any previous
            // active instance is shut down before establishing a new connection.
            if (SerialPortButton.activeInstance && SerialPortButton.activeInstance !== this) {
                _trace(SerialPortButton.RADIO_ID, 'connectSerialPort: tearing down previous active instance');
                SerialPortButton.activeInstance.shutdownRequested = true;
                SerialPortButton.activeInstance.lastConnected = false;
                await SerialPortButton.activeInstance.disconnect();
            }

            SerialPortButton.activeInstance = this;

            this.props.dispatch(setSerialPortConnected(SerialPortButton.RADIO_ID, false));
            this.props.dispatch(setSerialPortStatus(SerialPortButton.RADIO_ID, 'connecting'));
            this.wsUnavailableNotified = false;

            // If already connected, reset first.
            // IMPORTANT: suppress auto-reconnect while we reset existing resources.
            this.shutdownRequested = true;
            const hadExistingSocket = Boolean(this.socket);
            this.suppressNextSocketCloseEffects = hadExistingSocket;
            _trace(SerialPortButton.RADIO_ID, 'connectSerialPort: reset disconnect (suppress reconnect)');
            await this.disconnect({ clearActiveInstance: false });
            this.suppressNextSocketCloseEffects = false;
            this.shutdownRequested = false;

            // 1) get public IP.
            const clientIp = await this.getClientIP();
            _trace(SerialPortButton.RADIO_ID, 'connectSerialPort: got clientIp', clientIp);

            // 2) ask for a port
            const nav = navigator as unknown as NavigatorWithSerial;
            this.port = await nav.serial.requestPort();
            _trace(SerialPortButton.RADIO_ID, 'connectSerialPort: serial port selected');

            // 3) open with extra options
            await this.port.open({
                baudRate: 38400,
                parity: 'none',
                dataBits: 8,
                stopBits: 1,
                bufferSize: SerialPortButton.ONE_MIB,
                flowControl: 'none'
            });
            _trace(SerialPortButton.RADIO_ID, 'connectSerialPort: port.open complete');
            // force DTR/RTS low
            await this.port.setSignals({ dataTerminalReady: false, requestToSend: false });
            _trace(SerialPortButton.RADIO_ID, 'connectSerialPort: setSignals complete');

            // 4) start text decoding
            const textDecoder = new TextDecoderStream();
            // catch pipe errors
            this.decodeAbortController?.abort();
            this.decodeAbortController = new AbortController();
            this.decodePipe = (this.port.readable as unknown as ReadableStream<BufferSource>)
                .pipeTo(textDecoder.writable, { signal: this.decodeAbortController.signal })
                .catch(e => console.error('Pipe error:', e));

            this.reader = textDecoder.readable.getReader();
            this.writer = this.port.writable.getWriter();
            _trace(SerialPortButton.RADIO_ID, 'connectSerialPort: reader/writer acquired');

            // 5) start the WS using the client IP
            this.initializeWebSocket(clientIp);
            _trace(SerialPortButton.RADIO_ID, 'connectSerialPort: initializeWebSocket called');

            // 6) pump serial→WS
            this.readLoop().catch(e =>
                console.error('ReadLoop error:', e)
            );

            // 7) Start periodic serial polling (PS;).
            this.startPsPolling();

            // 8) Start PTT (CTS) monitor.
            this.startSignalMonitor();

            _trace(SerialPortButton.RADIO_ID, 'connectSerialPort: done');
        } catch (e) {
            this.props.dispatch(setSerialPortConnected(SerialPortButton.RADIO_ID, false));
            this.shutdownRequested = false;
            console.error('Connection error:', e);

            const radio = this.props.t(this.label) as unknown as string;
            const message = (e as any)?.message ? String((e as any).message) : String(e);

            this.props.dispatch(showWarningNotification({
                title: `${radio}: connect failed`,
                description: message
            }, NOTIFICATION_TIMEOUT_TYPE.STICKY));

            _trace(SerialPortButton.RADIO_ID, 'connectSerialPort: failed', e);
        }
    }

    initializeWebSocket(clientIp: string) {
        _trace(SerialPortButton.RADIO_ID, 'initializeWebSocket: start', {
            clientIp,
            existingSocket: Boolean(this.socket),
            shutdownRequested: this.shutdownRequested
        });

        // Update status while attempting connection.
        this.props.dispatch(setSerialPortStatus(
            SerialPortButton.RADIO_ID,
            this.reconnectRequested ? 'reconnecting' : 'connecting'
        ));
        this.reconnectRequested = false;
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
            _trace(SerialPortButton.RADIO_ID, 'ws: open');
            lastPong = Date.now();
            this.props.dispatch(setSerialPortConnected(SerialPortButton.RADIO_ID, true));
            this.props.dispatch(setSerialPortStatus(SerialPortButton.RADIO_ID, 'connected'));
            this.wsUnavailableNotified = false;

            if (!this.lastConnected) {
                this.props.dispatch(showSuccessNotification({
                    titleKey: 'serialPorts.connected',
                    titleArguments: {
                        radio: this.props.t(this.label) as unknown as string
                    }
                }, NOTIFICATION_TIMEOUT_TYPE.SHORT));
            }

            this.lastConnected = true;
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

                this.queueSerialWrite(event.data);
            } else if (event.data instanceof Blob) {
                const text = await event.data.text();

                this.queueSerialWrite(text);
            }
        });

        this.socket.addEventListener('error', () => {
            _trace(SerialPortButton.RADIO_ID, 'ws: error');
            // let onclose handle reconnect
        });

        this.socket.addEventListener('close', () => {
            _trace(SerialPortButton.RADIO_ID, 'ws: close', {
                shutdownRequested: this.shutdownRequested,
                suppressNextSocketCloseEffects: this.suppressNextSocketCloseEffects,
                lastConnected: this.lastConnected
            });
            this.stopHeartbeat();
            this.props.dispatch(setSerialPortConnected(SerialPortButton.RADIO_ID, false));

            const suppress = this.suppressNextSocketCloseEffects;
            this.suppressNextSocketCloseEffects = false;

            if (this.lastConnected && !suppress) {
                this.props.dispatch(showWarningNotification({
                    titleKey: 'serialPorts.disconnected',
                    titleArguments: {
                        radio: this.props.t(this.label) as unknown as string
                    }
                }, NOTIFICATION_TIMEOUT_TYPE.SHORT));
            } else if (!this.shutdownRequested && !suppress && !this.wsUnavailableNotified) {
                this.wsUnavailableNotified = true;
                this.props.dispatch(showWarningNotification({
                    titleKey: 'serialPorts.reconnecting',
                    titleArguments: {
                        radio: this.props.t(this.label) as unknown as string
                    }
                }, NOTIFICATION_TIMEOUT_TYPE.SHORT));
            }

            this.lastConnected = false;
            if (!this.shutdownRequested && !suppress) {
                this.props.dispatch(setSerialPortStatus(SerialPortButton.RADIO_ID, 'reconnecting'));
            } else {
                this.props.dispatch(setSerialPortStatus(SerialPortButton.RADIO_ID, 'disconnected'));
            }
            if (!suppress) {
                this.scheduleReconnect();
            }
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
            _trace(SerialPortButton.RADIO_ID, 'scheduleReconnect: suppressed due to shutdownRequested');
            return;
        }

        this.reconnectRequested = true;

        _trace(SerialPortButton.RADIO_ID, 'scheduleReconnect: scheduling');

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
                _trace(SerialPortButton.RADIO_ID, 'scheduleReconnect: aborted', {
                    shutdownRequested: this.shutdownRequested,
                    hasClientIp: Boolean(this.clientIp)
                });
                return;
            }
            _trace(SerialPortButton.RADIO_ID, 'scheduleReconnect: reconnecting now');
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

    private queueSerialWrite(data: string) {
        const writer = this.writer;

        if (!writer || this.shutdownRequested) {
            return;
        }

        // Preserve ordering but avoid blocking the WS 'message' handler.
        // Errors are expected during shutdown/abort; swallow them.
        const enc = new TextEncoder();
        this.serialWriteChain = this.serialWriteChain
            .then(() => writer.write(enc.encode(data)) as unknown as Promise<void>)
            .catch(() => undefined);
    }

    private startSignalMonitor() {
        this.stopSignalMonitor();

        this.signalPollTimer = setInterval(async () => {
            if (this.shutdownRequested || !this.port) {
                return;
            }

            // If the event loop is busy, async intervals can overlap and pile up.
            // Keep at most one getSignals() in flight.
            if (this.signalPollInFlight) {
                return;
            }

            this.signalPollInFlight = true;

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
            } finally {
                this.signalPollInFlight = false;
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
            this.queueSerialWrite('PS;');
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

            this.props.dispatch(showWarningNotification({
                titleKey: 'serialPorts.noResponse',
                titleArguments: {
                    radio: this.props.t(this.label) as unknown as string
                }
            }, NOTIFICATION_TIMEOUT_TYPE.STICKY));

            // shutdown everything, no reconnect
            this.shutdownRequested = true;
            _trace(SerialPortButton.RADIO_ID, 'PS timeout: shutdownRequested=true, disconnecting');
            this.props.dispatch(setSerialPortConnected(SerialPortButton.RADIO_ID, false));
            this.lastConnected = false;
            this.stopPsPolling();
            this.stopSignalMonitor();
            void this.disconnect();
        }, SerialPortButton.PS_TIMEOUT_MS);
    }

    override componentWillUnmount() {
        // This button is mounted inside the overflow menu, so it may unmount when
        // the menu closes. We do NOT want that to implicitly disconnect the radio.
        // Disconnection happens only on explicit shutdown (PS timeout) or manual code paths.
    }

    private async disconnect({ clearActiveInstance = true }: { clearActiveInstance?: boolean; } = {}) {
        _trace(SerialPortButton.RADIO_ID, 'disconnect: start', {
            shutdownRequested: this.shutdownRequested,
            hasPort: Boolean(this.port),
            hasSocket: Boolean(this.socket),
            hasReader: Boolean(this.reader),
            hasWriter: Boolean(this.writer)
        });
        this.props.dispatch(setSerialPortConnected(SerialPortButton.RADIO_ID, false));
        this.props.dispatch(setSerialPortStatus(SerialPortButton.RADIO_ID, 'disconnected'));
        this.stopPsPolling();
        this.stopSignalMonitor();
        this.stopHeartbeat();

        // Close the WS first so the bridge releases the radio even if the WebSerial shutdown hangs.
        const socket = this.socket;
        this.socket = null;

        if (socket) {
            try {
                socket.close(1000, 'client disconnect');
                _trace(SerialPortButton.RADIO_ID, 'disconnect: socket.close called');
            } catch (_) {
                // ignore
            }
        }

        const reader = this.reader;
        this.reader = null;

        const decodeAbortController = this.decodeAbortController;
        const decodePipe = this.decodePipe;
        this.decodeAbortController = null;
        this.decodePipe = null;

        if (decodeAbortController) {
            try {
                decodeAbortController.abort();
                _trace(SerialPortButton.RADIO_ID, 'disconnect: decodeAbortController.abort called');
            } catch (_) {
                // ignore
            }
        }

        if (decodePipe) {
            try {
                await decodePipe;
            } catch (_) {
                // ignore
            }
        }

        if (reader) {
            try {
                await reader.cancel();
            } catch (_) {
                // ignore
            }
            try {
                reader.releaseLock();
            } catch (_) {
                // ignore
            }
        }

        const writer = this.writer;
        this.writer = null;

        if (writer) {
            try {
                // Abort immediately instead of graceful close to avoid hanging on pending writes.
                await writer.abort();
            } catch (_) {
                // ignore
            }
            try {
                writer.releaseLock();
            } catch (_) {
                // ignore
            }
        }

        const port = this.port;
        this.port = null;

        if (port) {
            try {
                await port.close();
                _trace(SerialPortButton.RADIO_ID, 'disconnect: port.close complete');
            } catch (_) {
                // ignore
            }
        }

        if (clearActiveInstance && SerialPortButton.activeInstance === this) {
            SerialPortButton.activeInstance = null;
        }

        _trace(SerialPortButton.RADIO_ID, 'disconnect: done');
    }

    override render() {
        // we still just render the toolbar button
        return super.render();
    }
}

const mapStateToProps = (state: IReduxState) => ({
    serialConnected: Boolean(state['features/serial-ports']?.connectedById?.k3Radio1),
    serialStatus: state['features/serial-ports']?.statusById?.k3Radio1,
    visible: !isVpaasMeeting(state) && !isMobileBrowser() && 'serial' in navigator
});

export default translate(connect(mapStateToProps)(SerialPortButton));