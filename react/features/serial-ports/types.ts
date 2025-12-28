export type SerialPortStatus = 'disconnected' | 'connecting' | 'reconnecting' | 'connected';

export interface ISerialPortsState {
    connectedById: Record<string, boolean>;
    statusById: Record<string, SerialPortStatus>;
}
