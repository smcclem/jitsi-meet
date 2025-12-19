import { AnyAction } from 'redux';

import { IStore } from '../../app/types';
import { hideNotification } from '../../notifications/actions';
import { isPrejoinPageVisible } from '../../prejoin/functions.any';
import { setAudioSettings } from '../../settings/actions.web';
import { getAvailableDevices } from '../devices/actions.web';
import { SET_AUDIO_MUTED } from '../media/actionTypes';
import { gumPending, setScreenshareMuted } from '../media/actions';
import {
    MEDIA_TYPE,
    VIDEO_TYPE
} from '../media/constants';
import { isAudioMuted } from '../media/functions';
import { IGUMPendingState } from '../media/types';
import MiddlewareRegistry from '../redux/MiddlewareRegistry';

import {
    TRACK_ADDED,
    TRACK_MUTE_UNMUTE_FAILED,
    TRACK_NO_DATA_FROM_SOURCE,
    TRACK_REMOVED,
    TRACK_STOPPED,
    TRACK_UPDATED
} from './actionTypes';
import { _disposeAndRemoveTracks } from './actions.any';
import {
    createLocalTracksA,
    showNoDataFromSourceVideoError,
    toggleScreensharing,
    trackMuteUnmuteFailed,
    trackNoDataFromSourceNotificationInfoChanged
} from './actions.web';
import {
    getLocalJitsiAudioTrackSettings,
    getLocalTrack,
    getTrackByJitsiTrack,
    isUserInteractionRequiredForUnmute,
    logTracksForParticipant,
    setTrackMuted
} from './functions.web';
import logger from './logger';
import { ITrack, ITrackOptions } from './types';


import './middleware.any';
import './subscriber.web';

let _micAutoRecoveryInFlight = false;
let _lastMicAutoRecoveryTs = 0;

function _sleep(ms: number) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function _recoverLocalAudioTrackAfterStop(store: IStore, stoppedJitsiTrack: any) {
    if (_micAutoRecoveryInFlight) {
        return;
    }

    // Basic throttling to avoid loops if lib fires multiple stop events.
    const now = Date.now();

    if (now - _lastMicAutoRecoveryTs < 1000) {
        return;
    }

    _lastMicAutoRecoveryTs = now;
    _micAutoRecoveryInFlight = true;

    try {
        const { dispatch, getState } = store;
        // Windows/RDP device re-enumeration can take several seconds; retry while the user is
        // still expected to be sending audio (unmuted).
        const started = Date.now();
        const maxDurationMs = 20000;
        let attempts = 0;

        // Remove the stopped track from redux/conference once, if still present.
        {
            const state = getState();
            const stoppedTrack = getTrackByJitsiTrack(state['features/base/tracks'], stoppedJitsiTrack);

            if (stoppedTrack?.local && stoppedTrack.mediaType === MEDIA_TYPE.AUDIO) {
                await dispatch(_disposeAndRemoveTracks([ stoppedJitsiTrack ]));
            }
        }

        while (Date.now() - started < maxDurationMs) {
            const elapsedMs = Date.now() - started;

            const state = getState();

            // Abort if the user muted audio in the meantime, or if we are in prejoin.
            if (isPrejoinPageVisible(state) || isAudioMuted(state)) {
                return;
            }

            // If we are no longer in a conference context, do not attempt recovery.
            if (!APP.conference) {
                return;
            }

            // If we already have a usable local audio track, we're done. Include pending to avoid
            // starting a second gUM in parallel.
            const existingAudioTrack = getLocalTrack(state['features/base/tracks'], MEDIA_TYPE.AUDIO, true);

            if (existingAudioTrack?.jitsiTrack && !existingAudioTrack.muted) {
                return;
            }

            // If a (replacement) audio track is already being created, just wait for it.
            if (existingAudioTrack && !existingAudioTrack.jitsiTrack) {
                await _sleep(250);
                continue;
            }

            attempts++;

            logger.warn('Local audio track stopped unexpectedly; attempting auto-recovery', {
                attempt: attempts,
                elapsedMs
            });

            try {
                // Refresh devices list (helps when devices are re-enumerated).
                await dispatch(getAvailableDevices());

                // Recreate the local audio track (device selection is resolved from settings + device list).
                await dispatch(createLocalTracksA({ devices: [ MEDIA_TYPE.AUDIO ] }));
            } catch (error) {
                // Transient failures are expected while the OS is re-enumerating devices.
                // Keep retrying unless the user mutes/leaves.
                logger.warn('Local audio auto-recovery attempt failed; will retry', error);
            }

            const newAudioTrack = getLocalTrack(getState()['features/base/tracks'], MEDIA_TYPE.AUDIO);

            if (newAudioTrack?.jitsiTrack && !newAudioTrack.muted) {
                logger.warn('Local audio track auto-recovery succeeded');

                return;
            }

            // Progressive backoff.
            await _sleep(elapsedMs < 2000 ? 250 : (elapsedMs < 6000 ? 500 : 1000));
        }

        logger.warn('Local audio track auto-recovery gave up after retries');
    } catch (error) {
        logger.error('Local audio track auto-recovery failed', error);
    } finally {
        _micAutoRecoveryInFlight = false;
    }
}

/**
 * Middleware that captures LIB_DID_DISPOSE and LIB_DID_INIT actions and,
 * respectively, creates/destroys local media tracks. Also listens to
 * media-related actions and performs corresponding operations with tracks.
 *
 * @param {Store} store - The redux store.
 * @returns {Function}
 */
MiddlewareRegistry.register(store => next => action => {
    switch (action.type) {
    case TRACK_ADDED: {
        const { local } = action.track;

        // The devices list needs to be refreshed when no initial video permissions
        // were granted and a local video track is added by umuting the video.
        if (local) {
            store.dispatch(getAvailableDevices());
            break;
        }

        const result = next(action);
        const participantId = action.track?.participantId;

        if (participantId) {
            logTracksForParticipant(store.getState()['features/base/tracks'], participantId, 'Track added');
        }

        return result;
    }
    case TRACK_NO_DATA_FROM_SOURCE: {
        const result = next(action);

        _handleNoDataFromSourceErrors(store, action);

        return result;
    }

    case TRACK_REMOVED: {
        _removeNoDataFromSourceNotification(store, action.track);

        const result = next(action);
        const participantId = action.track?.jitsiTrack?.getParticipantId();

        if (participantId && !action.track?.jitsiTrack?.isLocal()) {
            logTracksForParticipant(store.getState()['features/base/tracks'], participantId, 'Track removed');
        }

        return result;
    }

    case TRACK_MUTE_UNMUTE_FAILED: {
        const { jitsiTrack } = action.track;
        const muted = action.wasMuted;
        const isVideoTrack = jitsiTrack.getType() !== MEDIA_TYPE.AUDIO;

        if (isVideoTrack && jitsiTrack.getVideoType() === VIDEO_TYPE.DESKTOP) {
            store.dispatch(setScreenshareMuted(!muted));
        } else if (isVideoTrack) {
            APP.conference.setVideoMuteStatus();
        } else {
            APP.conference.updateAudioIconEnabled();
        }

        break;
    }

    case TRACK_STOPPED: {
        const { jitsiTrack } = action.track;

        if (jitsiTrack.getVideoType() === VIDEO_TYPE.DESKTOP) {
            store.dispatch(toggleScreensharing(false));
        }

        if (jitsiTrack.isLocal() && jitsiTrack.getType() === MEDIA_TYPE.AUDIO) {
            // In Chromium on Windows, device re-enumeration (e.g. RDP reconnect) may end the underlying
            // MediaStreamTrack while the UI still shows the same selected mic. Attempt to recover by recreating
            // the local audio track while audio is expected to be unmuted.
            void _recoverLocalAudioTrackAfterStop(store, jitsiTrack);
        }
        break;
    }

    case TRACK_UPDATED: {
        // TODO Remove the following calls to APP.UI once components interested
        // in track mute changes are moved into React and/or redux.

        const result = next(action);
        const state = store.getState();

        if (isPrejoinPageVisible(state)) {
            return result;
        }

        const { jitsiTrack } = action.track;
        const participantID = jitsiTrack.getParticipantId();
        const isVideoTrack = jitsiTrack.type !== MEDIA_TYPE.AUDIO;
        const local = jitsiTrack.isLocal();

        if (isVideoTrack) {
            if (local && !(jitsiTrack.getVideoType() === VIDEO_TYPE.DESKTOP)) {
                APP.conference.setVideoMuteStatus();
            } else if (!local) {
                APP.UI.setVideoMuted(participantID);
            }
        } else if (local) {
            APP.conference.updateAudioIconEnabled();
        }

        if (typeof action.track?.muted !== 'undefined' && participantID && !local) {
            logTracksForParticipant(store.getState()['features/base/tracks'], participantID, 'Track updated');

            // Notify external API when remote participant mutes/unmutes themselves
            const mediaType = isVideoTrack
                ? (jitsiTrack.getVideoType() === VIDEO_TYPE.DESKTOP ? 'desktop' : 'video')
                : 'audio';

            APP.API.notifyParticipantMuted(participantID, action.track.muted, mediaType, true);
        }

        return result;
    }
    case SET_AUDIO_MUTED: {
        if (!action.muted
                && isUserInteractionRequiredForUnmute(store.getState())) {
            return;
        }

        _setMuted(store, action);
        break;
    }
    }

    return next(action);
});

/**
 * Handles no data from source errors.
 *
 * @param {Store} store - The redux store in which the specified action is
 * dispatched.
 * @param {Action} action - The redux action dispatched in the specified store.
 * @private
 * @returns {void}
 */
function _handleNoDataFromSourceErrors(store: IStore, action: AnyAction) {
    const { getState, dispatch } = store;

    const track = getTrackByJitsiTrack(getState()['features/base/tracks'], action.track.jitsiTrack);

    if (!track?.local) {
        return;
    }

    const { jitsiTrack } = track;

    if (track.mediaType === MEDIA_TYPE.AUDIO && track.isReceivingData) {
        _removeNoDataFromSourceNotification(store, action.track);
    }

    if (track.mediaType === MEDIA_TYPE.VIDEO) {
        const { noDataFromSourceNotificationInfo = {} } = track;

        if (track.isReceivingData) {
            if (noDataFromSourceNotificationInfo.timeout) {
                clearTimeout(noDataFromSourceNotificationInfo.timeout);
                dispatch(trackNoDataFromSourceNotificationInfoChanged(jitsiTrack, undefined));
            }

            // try to remove the notification if there is one.
            _removeNoDataFromSourceNotification(store, action.track);
        } else {
            if (noDataFromSourceNotificationInfo.timeout) {
                return;
            }

            const timeout = setTimeout(() => dispatch(showNoDataFromSourceVideoError(jitsiTrack)), 5000);

            dispatch(trackNoDataFromSourceNotificationInfoChanged(jitsiTrack, { timeout }));
        }
    }
}

/**
 * Removes the no data from source notification associated with the JitsiTrack if displayed.
 *
 * @param {Store} store - The redux store.
 * @param {Track} track - The redux action dispatched in the specified store.
 * @returns {void}
 */
function _removeNoDataFromSourceNotification({ getState, dispatch }: IStore, track: ITrack) {
    const t = getTrackByJitsiTrack(getState()['features/base/tracks'], track.jitsiTrack);
    const { jitsiTrack, noDataFromSourceNotificationInfo = {} } = t || {};

    if (noDataFromSourceNotificationInfo?.uid) {
        dispatch(hideNotification(noDataFromSourceNotificationInfo.uid));
        dispatch(trackNoDataFromSourceNotificationInfoChanged(jitsiTrack, undefined));
    }
}

/**
 * Mutes or unmutes a local track with a specific media type.
 *
 * @param {Store} store - The redux store in which the specified action is
 * dispatched.
 * @param {Action} action - The redux action dispatched in the specified store.
 * @private
 * @returns {void}
 */
function _setMuted(store: IStore, { ensureTrack, muted }: {
    ensureTrack: boolean; muted: boolean; }) {
    const { dispatch, getState } = store;
    const state = getState();
    const localTrack = getLocalTrack(state['features/base/tracks'], MEDIA_TYPE.AUDIO, /* includePending */ true);

    if (localTrack) {
        // The `jitsiTrack` property will have a value only for a localTrack for which `getUserMedia` has already
        // completed. If there's no `jitsiTrack`, then the `muted` state will be applied once the `jitsiTrack` is
        // created.
        const { jitsiTrack } = localTrack;

        if (jitsiTrack) {
            setTrackMuted(jitsiTrack, muted, state, dispatch)
            .catch(() => {
                dispatch(trackMuteUnmuteFailed(localTrack, muted));
            });
        }
    } else if (!muted && ensureTrack) {
        // TODO(saghul): reconcile these 2 types.
        dispatch(gumPending([ MEDIA_TYPE.AUDIO ], IGUMPendingState.PENDING_UNMUTE));

        const createTrackOptions: ITrackOptions = {
            devices: [ MEDIA_TYPE.AUDIO ],
        };

        dispatch(createLocalTracksA(createTrackOptions)).then(() => {
            dispatch(gumPending([ MEDIA_TYPE.AUDIO ], IGUMPendingState.NONE));
            const updatedSettings = getLocalJitsiAudioTrackSettings(getState());

            dispatch(setAudioSettings(updatedSettings));
        });
    }
}
