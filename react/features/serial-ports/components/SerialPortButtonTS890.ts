import React from 'react';
import { connect } from 'react-redux';
import { createToolbarEvent } from '../../analytics/AnalyticsEvents';
import { sendAnalytics } from '../../analytics/functions';
import { IReduxState } from '../../app/types';
import { translate } from '../../base/i18n/functions';
import { IconSerialPortTS890 } from '../../base/icons/svg';
import AbstractButton, { IProps as AbstractButtonProps } from '../../base/toolbox/components/AbstractButton';
import { isMobileBrowser } from '../../base/environment/utils';
import { isVpaasMeeting } from '../../jaas/functions';
import { showNotification, showSuccessNotification, showWarningNotification } from '../../notifications/actions';
import { NOTIFICATION_TIMEOUT_TYPE, NOTIFICATION_TYPE } from '../../notifications/constants';
import { setSerialPortConnected, setSerialPortStatus } from '../actions';
import SerialConnectionLed from './SerialConnectionLed';

const SERIAL_TRACE = true;

function _trace(prefix: string, message: string, extra?: any) {
    if (!SERIAL_TRACE) {
        return;
    }

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
        flowControl?: 'none' | 'hardware';
    }): Promise<void>;
    close(): Promise<void>;
    setSignals(signals: {
        dataTerminalReady?: boolean;
        requestToSend?: boolean;
    }): Promise<void>;
}

class SerialPortButtonTS890 extends AbstractButton<IProps> {
    override accessibilityLabel = 'toolbar.accessibilityLabel.serialPortTS890';  
    override icon = IconSerialPortTS890;
    override label = 'toolbar.serialPortTS890';
    override tooltip = 'toolbar.serialPortTS890';

    private port: SerialPortExtended | null = null;
    private reader: ReadableStreamDefaultReader<string> | null = null;
    private writer: WritableStreamDefaultWriter<Uint8Array> | null = null;
    private socket: WebSocket | null = null;

    private serialWriteChain: Promise<void> = Promise.resolve();

    private decodeAbortController: AbortController | null = null;
    private decodePipe: Promise<void> | null = null;

    private suppressNextSocketCloseReconnect = false;

    private wsUnavailableNotified = false;
    private reconnectRequested = false;

    private aiInterval: number | null = null;
    private psInterval: number | null = null;

    private static readonly RADIO_ID = 'ts890';

    private static activeInstance: SerialPortButtonTS890 | null = null;

    private lastConnected = false;

    private shutdownRequested = false;

    override _handleClick() {
        _trace(SerialPortButtonTS890.RADIO_ID, `_handleClick: serialConnected=${String(Boolean(this.props.serialConnected))}`);
        if (this.props.serialConnected) {
            // Treat second click as a manual disconnect.
            // The overflow menu can remount this component; disconnect the currently active instance.
            const active = SerialPortButtonTS890.activeInstance ?? this;

            active.shutdownRequested = true;
            _trace(SerialPortButtonTS890.RADIO_ID, 'manual disconnect requested', {
                activeIsThis: active === this
            });

            void active.disconnect();

            return;
        }

        this.shutdownRequested = false;
        SerialPortButtonTS890.activeInstance = this;
        this.connectSerialPort();
        sendAnalytics(createToolbarEvent('serial.port'));
    }

    override _getElementAfter() {
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
        const pc = new RTCPeerConnection({
            iceServers: [{ urls: 'stun:stun.l.google.com:19302' }]
        });
        return new Promise((resolve, reject) => {
            pc.onicecandidate = e => {
                if (e.candidate) {
                    const m = /([0-9]{1,3}(?:\.[0-9]{1,3}){3})/.exec(e.candidate.candidate);
                    if (m) {
                        resolve(m[1]);
                        pc.close();
                    }
                }
            };
            pc.createDataChannel('');
            pc.createOffer()
              .then(offer => pc.setLocalDescription(offer))
              .catch(reject);
        });
    }

    private async connectSerialPort() {
        try {
            // IMPORTANT: suppress auto-reconnect while we reset existing resources.
            this.shutdownRequested = true;

            _trace(SerialPortButtonTS890.RADIO_ID, 'connectSerialPort: start (reset mode)', {
                hasPort: Boolean(this.port),
                hasSocket: Boolean(this.socket),
                activeIsThis: SerialPortButtonTS890.activeInstance === this
            });

            if (SerialPortButtonTS890.activeInstance && SerialPortButtonTS890.activeInstance !== this) {
                _trace(SerialPortButtonTS890.RADIO_ID, 'connectSerialPort: tearing down previous active instance');
                SerialPortButtonTS890.activeInstance.shutdownRequested = true;
                SerialPortButtonTS890.activeInstance.lastConnected = false;
                await SerialPortButtonTS890.activeInstance.disconnect();
            }

            SerialPortButtonTS890.activeInstance = this;
            this.props.dispatch(setSerialPortConnected(SerialPortButtonTS890.RADIO_ID, false));
            this.props.dispatch(setSerialPortStatus(SerialPortButtonTS890.RADIO_ID, 'connecting'));
            this.wsUnavailableNotified = false;

            // Reset any existing resources owned by this instance.
            const hadExistingSocket = Boolean(this.socket);
            this.suppressNextSocketCloseReconnect = hadExistingSocket;
            _trace(SerialPortButtonTS890.RADIO_ID, 'connectSerialPort: reset disconnect (suppress reconnect)');
            await this.disconnect({ clearActiveInstance: false });
            this.suppressNextSocketCloseReconnect = false;
            this.shutdownRequested = false;

            _trace(SerialPortButtonTS890.RADIO_ID, 'connectSerialPort: reset complete');

            const clientIp = await this.getClientIP();
            _trace(SerialPortButtonTS890.RADIO_ID, 'connectSerialPort: got clientIp', clientIp);

            const nav = navigator as unknown as NavigatorWithSerial;
            this.port = await nav.serial.requestPort();
            _trace(SerialPortButtonTS890.RADIO_ID, 'connectSerialPort: serial port selected');

            await this.port.open({
                baudRate: 115200,
                parity: 'none',
                dataBits: 8,
                stopBits: 1,
                flowControl: 'none'
            });
            _trace(SerialPortButtonTS890.RADIO_ID, 'connectSerialPort: port.open complete');

            await this.port.setSignals({ dataTerminalReady: true, requestToSend: true });
            _trace(SerialPortButtonTS890.RADIO_ID, 'connectSerialPort: setSignals complete');

            const textDecoder = new TextDecoderStream();
            this.decodeAbortController?.abort();
            this.decodeAbortController = new AbortController();
            this.decodePipe = (this.port.readable as unknown as ReadableStream<BufferSource>)
                .pipeTo(textDecoder.writable, { signal: this.decodeAbortController.signal })
                .catch(e => console.warn('Pipe error:', e));

            this.reader = textDecoder.readable.getReader();
            this.writer = this.port.writable.getWriter();
            _trace(SerialPortButtonTS890.RADIO_ID, 'connectSerialPort: reader/writer acquired');

            this.initializeWebSocket(clientIp);
            this.readLoop().catch(e => console.error('ReadLoop error:', e));

            _trace(SerialPortButtonTS890.RADIO_ID, 'connectSerialPort: done');

        } catch (e: any) {
            this.props.dispatch(setSerialPortConnected(SerialPortButtonTS890.RADIO_ID, false));
            this.shutdownRequested = false;
            console.error('Connection error:', e);

            const radio = this.props.t(this.label) as unknown as string;
            const message = e?.message ? String(e.message) : String(e);

            this.props.dispatch(showWarningNotification({
                title: `${radio}: connect failed`,
                description: message
            }, NOTIFICATION_TIMEOUT_TYPE.STICKY));

            _trace(SerialPortButtonTS890.RADIO_ID, 'connectSerialPort: failed', e);
        }
    }

    private initializeWebSocket(clientIp: string) {
        _trace(SerialPortButtonTS890.RADIO_ID, 'initializeWebSocket: start', {
            clientIp,
            shutdownRequested: this.shutdownRequested
        });
        if (this.aiInterval) {
            clearInterval(this.aiInterval);
            this.aiInterval = null;
        }
        if (this.psInterval) {
            clearInterval(this.psInterval);
            this.psInterval = null;
        }

        this.props.dispatch(setSerialPortStatus(
            SerialPortButtonTS890.RADIO_ID,
            this.reconnectRequested ? 'reconnecting' : 'connecting'
        ));
        this.reconnectRequested = false;

        this.socket = new WebSocket(
            `wss://station.wu2x.com:8443/webRRL/ts890/websocket?clientIp=${encodeURIComponent(clientIp)}`
        );

        this.socket.addEventListener('open', () => {
            console.log('WebSocket connected!');
            _trace(SerialPortButtonTS890.RADIO_ID, 'ws: open');
            this.props.dispatch(setSerialPortConnected(SerialPortButtonTS890.RADIO_ID, true));
            this.props.dispatch(setSerialPortStatus(SerialPortButtonTS890.RADIO_ID, 'connected'));
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
            setTimeout(() => {
                this.aiInterval = window.setInterval(() => this.writeData('AI2;'), 3000);
            }, 3000);
            setTimeout(() => {
                this.psInterval = window.setInterval(() => this.writeData('PS;'), 2000);
            }, 3000);
        });

        this.socket.addEventListener('message', ev => {
            this.writeData(ev.data);
        });

        this.socket.addEventListener('error', ev => {
            console.error('WebSocket error:', ev);
            _trace(SerialPortButtonTS890.RADIO_ID, 'ws: error', ev);
        });

        this.socket.addEventListener('close', () => {
            console.log('WebSocket closed – reconnecting in 3s');
            _trace(SerialPortButtonTS890.RADIO_ID, 'ws: close', {
                shutdownRequested: this.shutdownRequested,
                suppressNextSocketCloseReconnect: this.suppressNextSocketCloseReconnect,
                lastConnected: this.lastConnected
            });
            this.props.dispatch(setSerialPortConnected(SerialPortButtonTS890.RADIO_ID, false));

            const suppressReconnect = this.suppressNextSocketCloseReconnect;
            this.suppressNextSocketCloseReconnect = false;

            if (this.lastConnected) {
                this.props.dispatch(showWarningNotification({
                    titleKey: 'serialPorts.disconnected',
                    titleArguments: {
                        radio: this.props.t(this.label) as unknown as string
                    }
                }, NOTIFICATION_TIMEOUT_TYPE.SHORT));
            } else if (!this.shutdownRequested && !suppressReconnect && !this.wsUnavailableNotified) {
                this.wsUnavailableNotified = true;
                this.props.dispatch(showWarningNotification({
                    titleKey: 'serialPorts.reconnecting',
                    titleArguments: {
                        radio: this.props.t(this.label) as unknown as string
                    }
                }, NOTIFICATION_TIMEOUT_TYPE.SHORT));
            }

            this.lastConnected = false;
            if (this.aiInterval) {
                clearInterval(this.aiInterval);
                this.aiInterval = null;
            }
            if (this.psInterval) {
                clearInterval(this.psInterval);
                this.psInterval = null;
            }

            if (!this.shutdownRequested && !suppressReconnect) {
                this.props.dispatch(setSerialPortStatus(SerialPortButtonTS890.RADIO_ID, 'reconnecting'));
                this.reconnectRequested = true;
                setTimeout(() => this.getClientIP().then(ip => this.initializeWebSocket(ip)), 3000);
            } else {
                this.props.dispatch(setSerialPortStatus(SerialPortButtonTS890.RADIO_ID, 'disconnected'));
            }
        });
    }

    private async readLoop() {
        let buffer = '';
        while (this.reader) {
            const { value, done } = await this.reader.read();
            if (done) {
                this.reader.releaseLock();
                break;
            }
            if (value) {
                buffer += value;
                const idx = buffer.lastIndexOf(';');
                if (idx !== -1) {
                    const cmd = buffer.slice(0, idx + 1);
                    buffer = buffer.slice(idx + 1);
                    this.socket?.send(cmd);
                }
            }
        }
    }

    private writeData(data: string) {
        const writer = this.writer;

        if (!writer || this.shutdownRequested) {
            return;
        }

        const enc = new TextEncoder();

        // Preserve ordering without forcing callers to await.
        this.serialWriteChain = this.serialWriteChain
            .then(() => writer.write(enc.encode(data)) as unknown as Promise<void>)
            .catch(() => undefined);
    }

    override componentWillUnmount() {
        // This button is mounted inside the overflow menu, so it may unmount when
        // the menu closes. We do NOT want that to implicitly disconnect the radio.
    }

    private async disconnect({ clearActiveInstance = true }: { clearActiveInstance?: boolean; } = {}) {
        _trace(SerialPortButtonTS890.RADIO_ID, 'disconnect: start', {
            shutdownRequested: this.shutdownRequested,
            hasPort: Boolean(this.port),
            hasSocket: Boolean(this.socket),
            hasReader: Boolean(this.reader),
            hasWriter: Boolean(this.writer)
        });
        this.props.dispatch(setSerialPortConnected(SerialPortButtonTS890.RADIO_ID, false));
        this.props.dispatch(setSerialPortStatus(SerialPortButtonTS890.RADIO_ID, 'disconnected'));
        // Do not clear lastConnected at the start of disconnect
        // this.lastConnected = false;
        if (this.aiInterval) {
            clearInterval(this.aiInterval);
            this.aiInterval = null;
        }
        if (this.psInterval) {
            clearInterval(this.psInterval);
            this.psInterval = null;
        }

        // Close the WS first so the bridge releases the radio even if the WebSerial shutdown hangs.
        const socket = this.socket;
        this.socket = null;

        if (socket) {
            try {
                socket.close(1000, 'client disconnect');
                _trace(SerialPortButtonTS890.RADIO_ID, 'disconnect: socket.close called');
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
                _trace(SerialPortButtonTS890.RADIO_ID, 'disconnect: decodeAbortController.abort called');
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
                _trace(SerialPortButtonTS890.RADIO_ID, 'disconnect: port.close complete');
            } catch (_) {
                // ignore
            }
        }

        if (clearActiveInstance && SerialPortButtonTS890.activeInstance === this) {
            SerialPortButtonTS890.activeInstance = null;
        }

        _trace(SerialPortButtonTS890.RADIO_ID, 'disconnect: done');
    }

    override render() {
        return super.render();
    }
}

const mapStateToProps = (state: IReduxState) => ({
    serialConnected: Boolean(state['features/serial-ports']?.connectedById?.ts890),
    serialStatus: state['features/serial-ports']?.statusById?.ts890,
    visible: !isVpaasMeeting(state) && !isMobileBrowser() && 'serial' in navigator
});

export default translate(connect(mapStateToProps)(SerialPortButtonTS890));
