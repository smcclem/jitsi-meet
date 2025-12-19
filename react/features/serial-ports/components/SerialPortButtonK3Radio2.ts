import { connect } from 'react-redux';
import { createToolbarEvent } from '../../analytics/AnalyticsEvents';
import { sendAnalytics } from '../../analytics/functions';
import { IReduxState } from '../../app/types';
import { translate } from '../../base/i18n/functions';
import { IconSerialPortK3Radio2} from '../../base/icons/svg';
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

class SerialPortButtonK3Radio2 extends AbstractButton<AbstractButtonProps> {
    accessibilityLabel = 'toolbar.accessibilityLabel.serialPortK3Radio2';
    icon = IconSerialPortK3Radio2; 
    label = 'toolbar.serialPortK3Radio2';
    tooltip = 'toolbar.serialPortK3Radio2';

    port: SerialPortExtended | null = null;
    writer: WritableStreamDefaultWriter<Uint8Array> | null = null;
    reader: ReadableStreamDefaultReader<string> | null = null;
    socket: WebSocket | null = null;

    _handleClick() {
        this.connectSerialPort();
        sendAnalytics(createToolbarEvent('serial.port'));
    }

    /**
     * Discover local IP via a STUN-based RTCPeerConnection trick
     */
    private async getClientIP(): Promise<string> {
        const pc = new RTCPeerConnection({
            iceServers: [{ urls: 'stun:stun.l.google.com:19302' }]
        });
        return new Promise((resolve, reject) => {
            pc.onicecandidate = e => {
                if (!e.candidate) {
                    reject(new Error('Could not find ICE candidate'));
                    return;
                }
                const m = /([0-9]{1,3}(?:\.[0-9]{1,3}){3})/.exec(e.candidate.candidate);
                if (m) {
                    resolve(m[1]);
                    pc.close();
                }
            };
            // some browsers require a data channel before they gather
            pc.createDataChannel('');
            pc.createOffer()
              .then(offer => pc.setLocalDescription(offer))
              .catch(reject);
        });
    }

    async connectSerialPort() {
        const { dispatch } = this.props;
        try {
            // 1) get the IP
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
                flowControl: 'none'
            });
            // force DTR/RTS low
            await this.port.setSignals({ dataTerminalReady: false, requestToSend: false });

            // 4) start text decoding
            const textDecoder = new TextDecoderStream();
            // catch pipe errors
            this.port.readable
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
        } catch (e) {
            console.error('Connection error:', e);
        }
    }

    initializeWebSocket(clientIp: string) {
        this.socket = new WebSocket(
            `wss://station.wu2x.com:8443/webRRL/k3s/radio2/websocket?clientIp=${encodeURIComponent(clientIp)}`
        );

        this.socket.addEventListener('open', () => {
            console.log('WebSocket connected');
        });

        this.socket.addEventListener('message', ev => {
            this.writeData(ev.data);
        });

        this.socket.addEventListener('close', () => {
            console.log('WS closed — reconnecting in 3s');
            setTimeout(() => this.initializeWebSocket(clientIp), 3000);
        });

        this.socket.addEventListener('error', ev => {
            console.error('WebSocket error:', ev);
        });
    }

    private async readLoop() {
        while (this.reader) {
            const { value, done } = await this.reader.read();
            if (done) {
                break;
            }
            if (value && this.socket?.readyState === WebSocket.OPEN) {
                this.socket.send(value);
            }
        }
    }

    async writeData(data: string) {
        if (!this.writer) {
            return;
        }
        const enc = new TextEncoder();
        await this.writer.write(enc.encode(data + '\n'));
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
    }

    render() {
        // we still just render the toolbar button
        return super.render();
    }
}

const mapStateToProps = (state: IReduxState) => ({
    visible: !isVpaasMeeting(state) && !isMobileBrowser() && 'serial' in navigator
});

export default translate(connect(mapStateToProps)(SerialPortButtonK3Radio2));