/* eslint-disable no-console */

import type {
    IHostToWorkerMessage,
    ISerialBridgeStartConfig,
    IWorkerToHostMessage,
    SerialToWsMode
} from './workerProtocol';

interface ISerialPortLike {
    readable: ReadableStream<Uint8Array>;
    writable: WritableStream<Uint8Array>;
    close(): Promise<void>;
}

let config: ISerialBridgeStartConfig | null = null;
let port: ISerialPortLike | null = null;
let reader: ReadableStreamDefaultReader<string> | null = null;
let writer: WritableStreamDefaultWriter<Uint8Array> | null = null;
let socket: WebSocket | null = null;

let decodeAbortController: AbortController | null = null;
let decodePipe: Promise<void> | null = null;

let shutdownRequested = false;

let serialWriteChain: Promise<void> = Promise.resolve();
let wsUnavailableNotified = false;
let lastWsConnected = false;

let pingTimer: ReturnType<typeof setInterval> | null = null;
let pongCheckTimer: ReturnType<typeof setInterval> | null = null;
let lastPongAt = Date.now();

let psInterval: ReturnType<typeof setInterval> | null = null;
let psTimeoutTimer: ReturnType<typeof setTimeout> | null = null;
let psAwaiting = false;
let psScanBuf = '';

let serialToWsBuffer = '';

let openCommandTimers: Array<ReturnType<typeof setInterval> | ReturnType<typeof setTimeout>> = [];

function post(msg: IWorkerToHostMessage) {
    // @ts-ignore
    (self as DedicatedWorkerGlobalScope).postMessage(msg);
}

function trace(message: string, extra?: any) {
    if (!config) {
        return;
    }

    post({ type: 'log', radioId: config.radioId, message, extra });
}

function setStatus(status: IWorkerToHostMessage & { type: 'status' }) {
    post(status);
}

function setConnected(connected: boolean) {
    if (!config) {
        return;
    }

    post({ type: 'connected', radioId: config.radioId, connected });
}

function fireEvent(event: IWorkerToHostMessage & { type: 'event' }) {
    post(event);
}

function stopHeartbeat() {
    if (pingTimer) {
        clearInterval(pingTimer);
        pingTimer = null;
    }
    if (pongCheckTimer) {
        clearInterval(pongCheckTimer);
        pongCheckTimer = null;
    }
}

function stopPsPolling() {
    if (psInterval) {
        clearInterval(psInterval);
        psInterval = null;
    }
    if (psTimeoutTimer) {
        clearTimeout(psTimeoutTimer);
        psTimeoutTimer = null;
    }
    psAwaiting = false;
}

function stopOpenCommandTimers() {
    for (const t of openCommandTimers) {
        clearInterval(t as any);
        clearTimeout(t as any);
    }
    openCommandTimers = [];
}

function queueSerialWrite(data: string) {
    if (!config || shutdownRequested) {
        return;
    }

    // Host-serial fallback: if worker doesn't own the port/writer,
    // request that the host writes this data to serial.
    if (!writer) {
        post({ type: 'serialWrite', radioId: config.radioId, data });

        return;
    }

    const enc = new TextEncoder();

    serialWriteChain = serialWriteChain
        .then(() => writer!.write(enc.encode(data)) as unknown as Promise<void>)
        .catch(() => undefined);
}

function processIncomingSerialText(value: string, mode: SerialToWsMode) {
    if (!config || shutdownRequested) {
        return;
    }

    // PS reply scanning.
    if (config.psPolling) {
        psScanBuf += value;
        if (psScanBuf.length > 2048) {
            psScanBuf = psScanBuf.slice(-1024);
        }

        const replyRegex = new RegExp(config.psPolling.replyRegexSource ?? '^PS[^;]*;');

        if (psAwaiting && replyRegex.test(psScanBuf)) {
            psAwaiting = false;
            if (psTimeoutTimer) {
                clearTimeout(psTimeoutTimer);
                psTimeoutTimer = null;
            }
        }
    }

    if (!socket || socket.readyState !== WebSocket.OPEN) {
        return;
    }

    if (mode === 'raw') {
        try {
            socket.send(value);
        } catch (_) {
            // ignore
        }

        return;
    }

    // semicolon-framed (TS-890)
    serialToWsBuffer += value;
    const idx = serialToWsBuffer.lastIndexOf(';');

    if (idx !== -1) {
        const cmd = serialToWsBuffer.slice(0, idx + 1);
        serialToWsBuffer = serialToWsBuffer.slice(idx + 1);
        try {
            socket.send(cmd);
        } catch (_) {
            // ignore
        }
    }
}

function startHeartbeat() {
    if (!config?.wsHeartbeat) {
        return;
    }

    stopHeartbeat();

    const { pingIntervalMs, pongStaleMs, checkIntervalMs } = config.wsHeartbeat;

    pingTimer = setInterval(() => {
        if (!socket || shutdownRequested || socket.readyState !== WebSocket.OPEN) {
            return;
        }
        try {
            socket.send(JSON.stringify({ type: 'ping', t: Date.now() }));
        } catch (_) {
            // ignore
        }
    }, pingIntervalMs);

    pongCheckTimer = setInterval(() => {
        if (shutdownRequested) {
            return;
        }
        if (Date.now() - lastPongAt > pongStaleMs) {
            try {
                socket?.close();
            } catch (_) {
                // ignore
            }
        }
    }, checkIntervalMs);

    lastPongAt = Date.now();
}

function scheduleReconnect() {
    if (!config || shutdownRequested) {
        trace('scheduleReconnect: suppressed', { shutdownRequested });

        return;
    }

    setStatus({ type: 'status', radioId: config.radioId, status: 'reconnecting' });

    setTimeout(() => {
        if (shutdownRequested || !config) {
            return;
        }

        initializeWebSocket();
    }, config.wsReconnectDelayMs);
}

function initializeWebSocket() {
    if (!config) {
        return;
    }

    trace('ws: initializing', { wsUrl: config.wsUrl });

    stopHeartbeat();

    if (socket) {
        socket.onopen = null;
        socket.onmessage = null;
        socket.onerror = null;
        socket.onclose = null;

        try {
            if (socket.readyState !== WebSocket.CLOSED) {
                socket.close();
            }
        } catch (_) {
            // ignore
        }
    }

    setStatus({ type: 'status', radioId: config.radioId, status: lastWsConnected ? 'reconnecting' : 'connecting' });

    socket = new WebSocket(config.wsUrl);

    socket.addEventListener('open', () => {
        if (!config) {
            return;
        }

        trace('ws: open');

        wsUnavailableNotified = false;

        if (!lastWsConnected) {
            fireEvent({ type: 'event', radioId: config.radioId, event: 'connected' });
        }

        lastWsConnected = true;

        setConnected(true);
        setStatus({ type: 'status', radioId: config.radioId, status: 'connected' });

        startHeartbeat();

        // Optional serial writes after WS is open (e.g. TS-890 AI/PS keepalives)
        stopOpenCommandTimers();
        const commands = config.onWsOpenSerialWrites ?? [];

        for (const cmd of commands) {
            const delay = cmd.delayMs ?? 0;
            const interval = cmd.intervalMs;

            if (interval && interval > 0) {
                const timer = setTimeout(() => {
                    if (shutdownRequested) {
                        return;
                    }
                    queueSerialWrite(cmd.data);
                    const it = setInterval(() => {
                        if (shutdownRequested) {
                            return;
                        }
                        queueSerialWrite(cmd.data);
                    }, interval);
                    openCommandTimers.push(it);
                }, delay);

                openCommandTimers.push(timer);
            } else {
                const timer = setTimeout(() => {
                    if (shutdownRequested) {
                        return;
                    }
                    queueSerialWrite(cmd.data);
                }, delay);

                openCommandTimers.push(timer);
            }
        }
    });

    socket.addEventListener('message', async event => {
        // heartbeat
        if (typeof event.data === 'string') {
            try {
                const msg = JSON.parse(event.data) as { type?: string; };
                if (msg.type === 'pong') {
                    lastPongAt = Date.now();
                    return;
                }
            } catch (_) {
                // not JSON
            }

            queueSerialWrite(event.data);
        } else if (event.data instanceof Blob) {
            const text = await event.data.text();

            queueSerialWrite(text);
        }
    });

    socket.addEventListener('error', () => {
        trace('ws: error');
        // close handler drives reconnect
    });

    socket.addEventListener('close', () => {
        if (!config) {
            return;
        }

        trace('ws: close', { shutdownRequested, lastWsConnected });

        stopHeartbeat();
        stopOpenCommandTimers();

        setConnected(false);

        if (lastWsConnected) {
            fireEvent({ type: 'event', radioId: config.radioId, event: 'disconnected' });
        } else if (!shutdownRequested && !wsUnavailableNotified) {
            wsUnavailableNotified = true;
            fireEvent({ type: 'event', radioId: config.radioId, event: 'reconnecting' });
        }

        lastWsConnected = false;

        if (!shutdownRequested) {
            scheduleReconnect();
        } else {
            setStatus({ type: 'status', radioId: config.radioId, status: 'disconnected' });
        }
    });
}

async function readLoop(mode: SerialToWsMode) {
    while (reader && !shutdownRequested) {
        const { value, done } = await reader.read();

        if (done) {
            break;
        }

        if (!value) {
            continue;
        }

        processIncomingSerialText(value, mode);
    }
}

function startPsPolling() {
    if (!config?.psPolling) {
        return;
    }

    stopPsPolling();

    const { pollIntervalMs, timeoutMs } = config.psPolling;

    const issue = () => {
        if (!config || shutdownRequested) {
            return;
        }

        queueSerialWrite('PS;');

        psAwaiting = true;

        if (psTimeoutTimer) {
            clearTimeout(psTimeoutTimer);
            psTimeoutTimer = null;
        }

        psTimeoutTimer = setTimeout(() => {
            if (!config || shutdownRequested) {
                return;
            }

            if (!psAwaiting) {
                return;
            }

            psAwaiting = false;

            fireEvent({ type: 'event', radioId: config.radioId, event: 'noResponse' });

            // Shutdown everything, no reconnect.
            shutdownRequested = true;
            setConnected(false);
            setStatus({ type: 'status', radioId: config.radioId, status: 'disconnected' });

            void disconnect('ps-timeout');
        }, timeoutMs);
    };

    issue();
    psInterval = setInterval(issue, pollIntervalMs);
}

async function startBridge(startConfig: ISerialBridgeStartConfig, newPort?: ISerialPortLike) {
    config = startConfig;
    port = newPort ?? null;

    shutdownRequested = false;
    wsUnavailableNotified = false;
    lastWsConnected = false;
    serialToWsBuffer = '';
    psScanBuf = '';

    setConnected(false);
    setStatus({ type: 'status', radioId: config.radioId, status: 'connecting' });

    // If worker can own the port, do serial I/O here. Otherwise, host-serial fallback.
    if (port?.readable && port?.writable) {
        const textDecoder = new TextDecoderStream();

        decodeAbortController?.abort();
        decodeAbortController = new AbortController();

        decodePipe = (port.readable as unknown as ReadableStream<BufferSource>)
            .pipeTo(textDecoder.writable, { signal: decodeAbortController.signal })
            .catch(e => {
                trace('serial: pipe error', String(e));
            });

        reader = textDecoder.readable.getReader();
        writer = port.writable.getWriter();
        trace('serial: attached (worker-owned)');
    } else {
        reader = null;
        writer = null;
        decodeAbortController = null;
        decodePipe = null;
        trace('serial: host-serial fallback mode');
    }

    initializeWebSocket();

    if (reader) {
        void readLoop(config.serialToWsMode).catch(e => {
            post({ type: 'error', radioId: config!.radioId, message: String(e) });
        });
    }

    startPsPolling();
}

async function disconnect(reason?: string) {
    if (!config) {
        return;
    }

    trace('disconnect: start', { reason });

    shutdownRequested = true;

    stopHeartbeat();
    stopPsPolling();
    stopOpenCommandTimers();

    // Close WS
    const s = socket;
    socket = null;

    if (s) {
        try {
            s.close(1000, reason ?? 'client disconnect');
        } catch (_) {
            // ignore
        }
    }

    // Stop serial decode
    const r = reader;
    reader = null;

    const da = decodeAbortController;
    const dp = decodePipe;
    decodeAbortController = null;
    decodePipe = null;

    if (da) {
        try {
            da.abort();
        } catch (_) {
            // ignore
        }
    }

    if (dp) {
        try {
            await dp;
        } catch (_) {
            // ignore
        }
    }

    if (r) {
        try {
            await r.cancel();
        } catch (_) {
            // ignore
        }

        try {
            r.releaseLock();
        } catch (_) {
            // ignore
        }
    }

    const w = writer;
    writer = null;

    if (w) {
        try {
            await w.abort();
        } catch (_) {
            // ignore
        }

        try {
            w.releaseLock();
        } catch (_) {
            // ignore
        }
    }

    const p = port;
    port = null;

    if (p) {
        try {
            await p.close();
        } catch (_) {
            // ignore
        }
    }

    setConnected(false);
    setStatus({ type: 'status', radioId: config.radioId, status: 'disconnected' });

    trace('disconnect: done');
}

// @ts-ignore
(self as DedicatedWorkerGlobalScope).onmessage = (ev: MessageEvent<IHostToWorkerMessage>) => {
    const msg = ev.data;

    if (msg.type === 'start') {
        void startBridge(msg.config, msg.port as ISerialPortLike | undefined).catch(e => {
            post({ type: 'error', radioId: msg.config.radioId, message: String(e) });
        });

        return;
    }

    if (msg.type === 'serialData') {
        if (!config) {
            return;
        }

        processIncomingSerialText(msg.data, config.serialToWsMode);

        return;
    }

    if (msg.type === 'send') {
        queueSerialWrite(msg.data);

        return;
    }

    if (msg.type === 'disconnect') {
        void disconnect(msg.reason);
    }
};
