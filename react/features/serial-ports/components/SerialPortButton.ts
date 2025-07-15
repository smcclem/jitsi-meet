import { connect } from 'react-redux';
import { createToolbarEvent } from '../../analytics/AnalyticsEvents';
import { sendAnalytics } from '../../analytics/functions';
import { IReduxState } from '../../app/types';
import { openDialog } from '../../base/dialog/actions';
import { isMobileBrowser } from '../../base/environment/utils';
import { translate } from '../../base/i18n/functions';
import { IconSerialPort } from '../../base/icons/svg';
import AbstractButton, { IProps as AbstractButtonProps } from '../../base/toolbox/components/AbstractButton';
import { isVpaasMeeting } from '../../jaas/functions';

interface NavigatorWithSerial extends Navigator {
    serial: {
        requestPort: () => Promise<SerialPort>;
    };
}

interface SerialPort {
    readable: ReadableStream;
    writable: WritableStream;
    open(options: { baudRate: number }): Promise<void>;
    close(): Promise<void>;
}

class SerialPortButton extends AbstractButton<AbstractButtonProps> {
    accessibilityLabel = 'toolbar.accessibilityLabel.serialPort';
    icon = IconSerialPort;
    label = 'toolbar.serialPort';
    tooltip = 'toolbar.serialPort';

    port: SerialPort | null = null;
    writer: WritableStreamDefaultWriter<Uint8Array> | null = null;
    reader: ReadableStreamDefaultReader<string> | null = null;
    socket: WebSocket | null = null;

    _handleClick() {
        const { dispatch } = this.props;
        this.connectSerialPort();
        sendAnalytics(createToolbarEvent('serial.port'));
    }

    async connectSerialPort() {
        const navigatorWithSerial = navigator as unknown as NavigatorWithSerial;

        if (!this.port) {
            try {
                this.port = await navigatorWithSerial.serial.requestPort();
                await this.port.open({ baudRate: 38400 });

                const textDecoder = new TextDecoderStream();
                this.port.readable.pipeTo(textDecoder.writable);
                this.reader = textDecoder.readable.getReader();
                this.writer = this.port.writable.getWriter() as unknown as WritableStreamDefaultWriter<Uint8Array>;

                this.readLoop();
            } catch (e) {
                console.error('Connection error:', e);
                return;
            }
        }

        this.initializeWebSocket();
    }

    initializeWebSocket() {
        this.socket = new WebSocket('wss://station.wu2x.com:8443/webRRL/websocket');

        this.socket.addEventListener('open', () => {
            // Handle WebSocket open event
        });

        this.socket.addEventListener('message', event => {
            this.writeData(event.data);
        });

        this.socket.addEventListener('close', () => {
            // Handle WebSocket close event
            setTimeout(() => this.initializeWebSocket(), 3000); // Reconnect after 3 seconds
        });

        this.socket.addEventListener('error', event => {
            // Handle WebSocket error event
        });
    }

    async readLoop() {
        while (true) {
            const result = await this.reader?.read();
            if (result) {
                const { value, done } = result;
                if (done) {
                    break;
                }
                if (value) {
                    this.socket?.send(value);
                }
            }
        }
    }

    async writeData(data: string) {
        const textEncoder = new TextEncoder();
        const encodedData = textEncoder.encode(data + '\n');
        await this.writer?.write(encodedData);
    }

    componentWillUnmount() {
        this.disconnect();
    }

    async disconnect() {
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
}

const mapStateToProps = (state: IReduxState) => {
    return {
        visible: !isVpaasMeeting(state) && !isMobileBrowser()
    };
};

export default translate(connect(mapStateToProps)(SerialPortButton));