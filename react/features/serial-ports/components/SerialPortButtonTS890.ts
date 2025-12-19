import { connect } from 'react-redux';
import { createToolbarEvent } from '../../analytics/AnalyticsEvents';
import { sendAnalytics } from '../../analytics/functions';
import { IReduxState } from '../../app/types';
import { translate } from '../../base/i18n/functions';
import { IconSerialPortTS890 } from '../../base/icons/svg';
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
        flowControl?: 'none' | 'hardware';
    }): Promise<void>;
    close(): Promise<void>;
    setSignals(signals: {
        dataTerminalReady?: boolean;
        requestToSend?: boolean;
    }): Promise<void>;
}

class SerialPortButtonTS890 extends AbstractButton<AbstractButtonProps> {
    accessibilityLabel = 'toolbar.accessibilityLabel.serialPortTS890';  
    icon = IconSerialPortTS890;
    label = 'toolbar.serialPortTS890';
    tooltip = 'toolbar.serialPortTS890';

    private port: SerialPortExtended | null = null;
    private reader: ReadableStreamDefaultReader<string> | null = null;
    private writer: WritableStreamDefaultWriter<Uint8Array> | null = null;
    private socket: WebSocket | null = null;

    private aiInterval: number | null = null;
    private psInterval: number | null = null;

    _handleClick() {
        this.connectSerialPort();
        sendAnalytics(createToolbarEvent('serial.port'));
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
        if (this.port && this.port.readable && this.port.writable) {
            console.log('Port already open – reusing connection');
            return;
        }

        try {
            const clientIp = await this.getClientIP();

            const nav = navigator as unknown as NavigatorWithSerial;
            this.port = await nav.serial.requestPort();

            await this.port.open({
                baudRate: 115200,
                parity: 'none',
                dataBits: 8,
                stopBits: 1,
                flowControl: 'none'
            });

            await this.port.setSignals({ dataTerminalReady: true, requestToSend: true });

            const textDecoder = new TextDecoderStream();
            this.port.readable
                .pipeTo(textDecoder.writable)
                .catch(e => console.warn('Pipe error:', e));

            this.reader = textDecoder.readable.getReader();
            this.writer = this.port.writable.getWriter();

            this.initializeWebSocket(clientIp);
            this.readLoop().catch(e => console.error('ReadLoop error:', e));

        } catch (e: any) {
            console.error('Connection error:', e);
        }
    }

    private initializeWebSocket(clientIp: string) {
        if (this.aiInterval) {
            clearInterval(this.aiInterval);
            this.aiInterval = null;
        }
        if (this.psInterval) {
            clearInterval(this.psInterval);
            this.psInterval = null;
        }

        this.socket = new WebSocket(
            `wss://station.wu2x.com:8443/webRRL/ts890/websocket?clientIp=${encodeURIComponent(clientIp)}`
        );

        this.socket.addEventListener('open', () => {
            console.log('WebSocket connected!');
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
        });

        this.socket.addEventListener('close', () => {
            console.log('WebSocket closed – reconnecting in 3s');
            if (this.aiInterval) {
                clearInterval(this.aiInterval);
                this.aiInterval = null;
            }
            if (this.psInterval) {
                clearInterval(this.psInterval);
                this.psInterval = null;
            }
            setTimeout(() => this.getClientIP().then(ip => this.initializeWebSocket(ip)), 3000);
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

    private async writeData(data: string) {
        if (!this.writer) {
            return;
        }
        const enc = new TextEncoder();
        await this.writer.write(enc.encode(data));
    }

    componentWillUnmount() {
        this.disconnect();
    }

    private async disconnect() {
        if (this.reader) {
            await this.reader.cancel();
            this.reader.releaseLock();
            this.reader = null;
        }
        if (this.writer) {
            await this.writer.close();
            this.writer.releaseLock();
            this.writer = null;
        }
        if (this.port) {
            await this.port.close();
            this.port = null;
        }
        if (this.socket) {
            this.socket.close();
            this.socket = null;
        }
        if (this.aiInterval) {
            clearInterval(this.aiInterval);
            this.aiInterval = null;
        }
        if (this.psInterval) {
            clearInterval(this.psInterval);
            this.psInterval = null;
        }
    }

    render() {
        return super.render();
    }
}

const mapStateToProps = (state: IReduxState) => ({
    visible: !isVpaasMeeting(state) && !isMobileBrowser() && 'serial' in navigator
});

export default translate(connect(mapStateToProps)(SerialPortButtonTS890));
