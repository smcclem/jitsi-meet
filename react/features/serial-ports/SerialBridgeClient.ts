import { getBaseUrl } from '../base/util/helpers';

import type {
    ISerialBridgeStartConfig,
    IWorkerToHostMessage
} from './workerProtocol';

export type SerialBridgeEventHandler = (msg: IWorkerToHostMessage) => void;

/**
 * Main-thread wrapper around the serial bridge worker.
 *
 * Note: WebSerial permission prompts require a user gesture on the main thread;
 * callers should request and open the SerialPort in the UI thread, then transfer
 * the opened port into the worker.
 */
export default class SerialBridgeClient {
    private _worker: Worker | null = null;
    private _workerObjectUrl: string | null = null;

    // Host-serial fallback mode (when SerialPort cannot be cloned/transferred to worker).
    private _hostMode = false;
    private _hostPort: any | null = null;
    private _hostReader: ReadableStreamDefaultReader<string> | null = null;
    private _hostWriter: WritableStreamDefaultWriter<Uint8Array> | null = null;
    private _hostDecodeAbortController: AbortController | null = null;
    private _hostDecodePipe: Promise<void> | null = null;
    private _hostShutdownRequested = false;
    private _hostSerialWriteChain: Promise<void> = Promise.resolve();
    private _hostPendingWrites: string[] = [];

    constructor(private readonly _radioId: string, private readonly _onMessage: SerialBridgeEventHandler) {
        this._createWorker();
    }

    start(config: ISerialBridgeStartConfig, port: any) {
        if (!this._worker) {
            this._createWorker();
        }

        if (!this._worker) {
            throw new Error('Worker not available');
        }

        // Reset any prior host-serial state for this instance.
        this._hostShutdownRequested = false;
        this._hostMode = false;
        this._hostPort = null;

        // Try transferring/cloning the port into the worker.
        // If this browser build cannot clone/transfer SerialPort, this will throw a DataCloneError.
        try {
            this._worker.postMessage({ type: 'start', config, port }, [ port ]);
            return;
        } catch (_) {
            // fall through
        }

        try {
            this._worker.postMessage({ type: 'start', config, port });
            return;
        } catch (e) {
            // Host-serial fallback: keep port on main thread and run WS/logic in worker.
            this._hostMode = true;
            this._hostPort = port;
            this._worker.postMessage({ type: 'start', config });
            void this._startHostSerialIo().catch(err => {
                this._onMessage({ type: 'error', radioId: this._radioId, message: String(err) });
            });
        }
    }

    send(data: string) {
        this._worker?.postMessage({ type: 'send', data });
    }

    disconnect(reason?: string) {
        this._worker?.postMessage({ type: 'disconnect', reason });

        if (this._hostMode) {
            this._hostShutdownRequested = true;
            void this._shutdownHostSerial();
        }
    }

    terminate() {
        // In host-serial fallback mode, the SerialPort belongs to the main thread.
        if (this._hostMode) {
            this._hostShutdownRequested = true;
            void this._shutdownHostSerial();
        }

        if (this._worker) {
            this._worker.terminate();
            this._worker = null;
        }

        if (this._workerObjectUrl) {
            URL.revokeObjectURL(this._workerObjectUrl);
            this._workerObjectUrl = null;
        }

        this._hostMode = false;
        this._hostPort = null;
    }

    private _createWorker() {
        const baseUrl = `${getBaseUrl()}libs/`;
        const workerUrlMin = `${baseUrl}serial-bridge-worker.min.js`;
        const workerUrlDev = `${baseUrl}serial-bridge-worker.js`;

        // Import the bundled worker script via importScripts so it runs in a DedicatedWorkerGlobalScope.
        const workerBlob = new Blob([
            `try { importScripts("${workerUrlMin}"); } catch (e) { importScripts("${workerUrlDev}"); }`
        ]);

        const objectUrl = URL.createObjectURL(workerBlob);

        this._workerObjectUrl = objectUrl;
        this._worker = new Worker(objectUrl, { name: `Serial bridge (${this._radioId})` });

        this._worker.onmessage = ({ data }: MessageEvent<IWorkerToHostMessage>) => {
            // Host-serial fallback: worker requests host writes.
            if (data.type === 'serialWrite') {
                if (this._hostMode) {
                    this._queueHostSerialWrite(data.data);
                }

                return;
            }

            this._onMessage(data);
        };

        this._worker.onerror = (e: ErrorEvent) => {
            this._onMessage({ type: 'error', radioId: this._radioId, message: e.message });
        };
    }

    private async _startHostSerialIo() {
        if (!this._worker || !this._hostPort || this._hostShutdownRequested) {
            return;
        }

        // Decoder: port.readable (Uint8Array) -> text chunks.
        const textDecoder = new TextDecoderStream();

        this._hostDecodeAbortController?.abort();
        this._hostDecodeAbortController = new AbortController();

        this._hostDecodePipe = (this._hostPort.readable as unknown as ReadableStream<BufferSource>)
            .pipeTo(textDecoder.writable, { signal: this._hostDecodeAbortController.signal })
            .catch(() => undefined);

        this._hostReader = textDecoder.readable.getReader();
        this._hostWriter = this._hostPort.writable.getWriter();

        // Flush any early worker write requests that arrived before writer init.
        if (this._hostPendingWrites.length) {
            const pending = this._hostPendingWrites;
            this._hostPendingWrites = [];

            for (const data of pending) {
                this._queueHostSerialWrite(data);
            }
        }

        while (this._hostReader && !this._hostShutdownRequested) {
            const { value, done } = await this._hostReader.read();

            if (done) {
                break;
            }

            if (!value) {
                continue;
            }

            try {
                this._worker.postMessage({ type: 'serialData', data: value });
            } catch (_) {
                // ignore
            }
        }
    }

    private _queueHostSerialWrite(data: string) {
        const w = this._hostWriter;

        if (this._hostShutdownRequested) {
            return;
        }

        if (!w) {
            this._hostPendingWrites.push(data);
            return;
        }

        const enc = new TextEncoder();
        this._hostSerialWriteChain = this._hostSerialWriteChain
            .then(() => w.write(enc.encode(data)) as unknown as Promise<void>)
            .catch(() => undefined);
    }

    private async _shutdownHostSerial() {
        this._hostPendingWrites = [];

        const r = this._hostReader;
        this._hostReader = null;

        const da = this._hostDecodeAbortController;
        const dp = this._hostDecodePipe;
        this._hostDecodeAbortController = null;
        this._hostDecodePipe = null;

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

        const w = this._hostWriter;
        this._hostWriter = null;

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

        const p = this._hostPort;
        this._hostPort = null;

        if (p) {
            try {
                await p.close();
            } catch (_) {
                // ignore
            }
        }
    }
}
