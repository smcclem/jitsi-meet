import ReducerRegistry from '../base/redux/ReducerRegistry';

import { SET_SERIAL_PORT_CONNECTED, SET_SERIAL_PORT_STATUS } from './actionTypes';
import type { ISerialPortsState } from './types';

const DEFAULT_STATE: ISerialPortsState = {
    connectedById: {},
    statusById: {}
};

ReducerRegistry.register<ISerialPortsState>(
'features/serial-ports',
(state: ISerialPortsState = DEFAULT_STATE, action): ISerialPortsState => {
    switch (action.type) {
    case SET_SERIAL_PORT_CONNECTED: {
        const { id, connected } = action as { id: string; connected: boolean; };

        if (state.connectedById[id] === connected) {
            return state;
        }

        return {
            ...state,
            connectedById: {
                ...state.connectedById,
                [id]: connected
            }
        };
    }
    case SET_SERIAL_PORT_STATUS: {
        const { id, status } = action as { id: string; status: ISerialPortsState['statusById'][string]; };

        if (state.statusById[id] === status) {
            return state;
        }

        return {
            ...state,
            statusById: {
                ...state.statusById,
                [id]: status
            }
        };
    }
    default:
        return state;
    }
});
