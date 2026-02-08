import { SerialPortStatus } from './types';

export type SerialToWsMode = 'raw' | 'semicolonFramed';

export interface ISerialHeartbeatConfig {
    pingIntervalMs: number;
    pongStaleMs: number;
    checkIntervalMs: number;
}

export interface IPsPollingConfig {
    pollIntervalMs: number;
    timeoutMs: number;
    /** Defaults to /^PS[^;]*;/. */
    replyRegexSource?: string;
}

export interface ISerialBridgeStartConfig {
    radioId: string;
    wsUrl: string;
    wsReconnectDelayMs: number;
    wsHeartbeat?: ISerialHeartbeatConfig;
    serialToWsMode: SerialToWsMode;

    /** Optional commands to send to serial after WS connects. */
    onWsOpenSerialWrites?: Array<{ data: string; delayMs?: number; intervalMs?: number; }>;

    psPolling?: IPsPollingConfig;
}

export type IHostToWorkerMessage =
    | { type: 'start'; config: ISerialBridgeStartConfig; port?: any }
    | { type: 'disconnect'; reason?: string }
    | { type: 'send'; data: string }
    /** Host-serial fallback: serial bytes (as decoded text) from host -> worker. */
    | { type: 'serialData'; data: string };

export type IWorkerToHostMessage =
    | { type: 'status'; radioId: string; status: SerialPortStatus }
    | { type: 'connected'; radioId: string; connected: boolean }
    | { type: 'event'; radioId: string; event: 'connected' | 'disconnected' | 'reconnecting' | 'noResponse' }
    | { type: 'log'; radioId: string; message: string; extra?: any }
    | { type: 'error'; radioId: string; message: string }
    /** Host-serial fallback: worker requests host to write to serial. */
    | { type: 'serialWrite'; radioId: string; data: string };
