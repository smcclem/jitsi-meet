import React from 'react';
import { connect } from 'react-redux';

import { createToolbarEvent } from '../../analytics/AnalyticsEvents';
import { sendAnalytics } from '../../analytics/functions';
import { IReduxState } from '../../app/types';
import { isMobileBrowser } from '../../base/environment/utils';
import { translate } from '../../base/i18n/functions';
import { IconSerialPortTS890 } from '../../base/icons/svg';
import AbstractButton, { IProps as AbstractButtonProps } from '../../base/toolbox/components/AbstractButton';
import { isVpaasMeeting } from '../../jaas/functions';
import { showSuccessNotification, showWarningNotification } from '../../notifications/actions';
import { NOTIFICATION_TIMEOUT_TYPE } from '../../notifications/constants';

import SerialBridgeClient from '../SerialBridgeClient';
import { setSerialPortConnected, setSerialPortStatus } from '../actions';
import type { ISerialBridgeStartConfig, IWorkerToHostMessage } from '../workerProtocol';

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
}

class SerialPortButtonTS890 extends AbstractButton<IProps> {
    override accessibilityLabel = 'toolbar.accessibilityLabel.serialPortTS890';
    override icon = IconSerialPortTS890;
    override label = 'toolbar.serialPortTS890';
    override tooltip = 'toolbar.serialPortTS890';

    private static readonly RADIO_ID = 'ts890';
    private static readonly ONE_MIB = 1024 * 1024;

    private static activeInstance: SerialPortButtonTS890 | null = null;

    private clientIp: string | null = null;
    private shutdownRequested = false;

    private port: SerialPortExtended | null = null;
    private bridgeClient: SerialBridgeClient | null = null;

    private _onWorkerMessage = (msg: IWorkerToHostMessage) => {
        if (msg.radioId !== SerialPortButtonTS890.RADIO_ID) {
            return;
        }

        if (msg.type === 'log') {
            _trace(SerialPortButtonTS890.RADIO_ID, msg.message, msg.extra);
            return;
        }

        if (msg.type === 'status') {
            this.props.dispatch(setSerialPortStatus(SerialPortButtonTS890.RADIO_ID, msg.status));
            return;
        }

        if (msg.type === 'connected') {
            this.props.dispatch(setSerialPortConnected(SerialPortButtonTS890.RADIO_ID, msg.connected));
            return;
        }

        if (msg.type === 'event') {
            const radio = this.props.t(this.label) as unknown as string;

            if (msg.event === 'connected') {
                this.props.dispatch(showSuccessNotification({
                    titleKey: 'serialPorts.connected',
                    titleArguments: { radio }
                }, NOTIFICATION_TIMEOUT_TYPE.SHORT));
            } else if (msg.event === 'disconnected') {
                this.props.dispatch(showWarningNotification({
                    titleKey: 'serialPorts.disconnected',
                    titleArguments: { radio }
                }, NOTIFICATION_TIMEOUT_TYPE.SHORT));
            } else if (msg.event === 'reconnecting') {
                this.props.dispatch(showWarningNotification({
                    titleKey: 'serialPorts.reconnecting',
                    titleArguments: { radio }
                }, NOTIFICATION_TIMEOUT_TYPE.SHORT));
            } else if (msg.event === 'noResponse') {
                this.shutdownRequested = true;
                this.props.dispatch(showWarningNotification({
                    titleKey: 'serialPorts.noResponse',
                    titleArguments: { radio }
                }, NOTIFICATION_TIMEOUT_TYPE.STICKY));
            }

            return;
        }

        if (msg.type === 'error') {
            const radio = this.props.t(this.label) as unknown as string;
            this.props.dispatch(showWarningNotification({
                title: `${radio}: worker error`,
                description: msg.message
            }, NOTIFICATION_TIMEOUT_TYPE.STICKY));
        }
    };

    override _handleClick() {
        _trace(SerialPortButtonTS890.RADIO_ID, `_handleClick: serialConnected=${String(Boolean(this.props.serialConnected))}`);

        if (this.props.serialConnected) {
            const active = SerialPortButtonTS890.activeInstance ?? this;
            active.shutdownRequested = true;
            void active.disconnect();

            return;
        }

        void this.connectSerialPort();
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

    private async connectSerialPort() {
        try {
            if (SerialPortButtonTS890.activeInstance && SerialPortButtonTS890.activeInstance !== this) {
                SerialPortButtonTS890.activeInstance.shutdownRequested = true;
                await SerialPortButtonTS890.activeInstance.disconnect();
            }

            SerialPortButtonTS890.activeInstance = this;
            this.shutdownRequested = false;

            this.props.dispatch(setSerialPortConnected(SerialPortButtonTS890.RADIO_ID, false));
            this.props.dispatch(setSerialPortStatus(SerialPortButtonTS890.RADIO_ID, 'connecting'));

            this.bridgeClient?.terminate();
            this.bridgeClient = null;

            const clientIp = await this.getClientIP();

            const nav = navigator as unknown as NavigatorWithSerial;
            this.port = await nav.serial.requestPort();

            await this.port.open({
                baudRate: 115200,
                parity: 'none',
                dataBits: 8,
                stopBits: 1,
                bufferSize: SerialPortButtonTS890.ONE_MIB,
                flowControl: 'none'
            });

            await this.port.setSignals({ dataTerminalReady: false, requestToSend: false });

            this.bridgeClient = new SerialBridgeClient(SerialPortButtonTS890.RADIO_ID, this._onWorkerMessage);

            const workerConfig: ISerialBridgeStartConfig = {
                radioId: SerialPortButtonTS890.RADIO_ID,
                wsUrl: `wss://station.wu2x.com:8443/webRRL/ts890/websocket?clientIp=${encodeURIComponent(clientIp)}`,
                wsReconnectDelayMs: 100,
                wsHeartbeat: {
                    pingIntervalMs: 25_000,
                    pongStaleMs: 35_000,
                    checkIntervalMs: 5_000
                },
                serialToWsMode: 'semicolonFramed',
                onWsOpenSerialWrites: [
                    { data: 'AI0;' },
                    { data: 'GT00;' }
                ],
                psPolling: {
                    pollIntervalMs: 5_000,
                    timeoutMs: 2_000
                }
            };

            this.bridgeClient.start(workerConfig, this.port);
            this.port = null;

            _trace(SerialPortButtonTS890.RADIO_ID, 'connectSerialPort: started worker');
        } catch (e) {
            const radio = this.props.t(this.label) as unknown as string;
            const message = (e as any)?.message ? String((e as any).message) : String(e);

            this.props.dispatch(setSerialPortConnected(SerialPortButtonTS890.RADIO_ID, false));
            this.props.dispatch(setSerialPortStatus(SerialPortButtonTS890.RADIO_ID, 'disconnected'));

            this.bridgeClient?.terminate();
            this.bridgeClient = null;

            if (this.port) {
                try {
                    await this.port.close();
                } catch (_) {
                    // ignore
                }
                this.port = null;
            }

            this.props.dispatch(showWarningNotification({
                title: `${radio}: connect failed`,
                description: message
            }, NOTIFICATION_TIMEOUT_TYPE.STICKY));

            _trace(SerialPortButtonTS890.RADIO_ID, 'connectSerialPort: failed', e);
        }
    }

    override componentWillUnmount() {
        // Mounted inside overflow menu; do not implicitly disconnect on unmount.
    }

    private async disconnect({ clearActiveInstance = true }: { clearActiveInstance?: boolean; } = {}) {
        this.props.dispatch(setSerialPortConnected(SerialPortButtonTS890.RADIO_ID, false));
        this.props.dispatch(setSerialPortStatus(SerialPortButtonTS890.RADIO_ID, 'disconnected'));

        this.shutdownRequested = true;

        if (this.bridgeClient) {
            try {
                this.bridgeClient.disconnect('client disconnect');
            } catch (_) {
                // ignore
            }

            const client = this.bridgeClient;
            this.bridgeClient = null;
            setTimeout(() => client.terminate(), 200);
        }

        if (this.port) {
            try {
                await this.port.close();
            } catch (_) {
                // ignore
            }
            this.port = null;
        }

        if (clearActiveInstance && SerialPortButtonTS890.activeInstance === this) {
            SerialPortButtonTS890.activeInstance = null;
        }
    }
}

const mapStateToProps = (state: IReduxState) => ({
    serialConnected: Boolean(state['features/serial-ports']?.connectedById?.ts890),
    serialStatus: state['features/serial-ports']?.statusById?.ts890,
    visible: !isVpaasMeeting(state) && !isMobileBrowser() && 'serial' in navigator
});

export default translate(connect(mapStateToProps)(SerialPortButtonTS890));
