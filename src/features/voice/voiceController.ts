import { createStore } from 'zustand/vanilla';
import type { VoiceDenial, VoiceRoom } from '@/engine/index.ts';
import type { Credentials } from '@/lib/gameApi';
import type { VoiceApi } from '@/lib/voiceApi';

/**
 * Push-to-talk, as one state machine. Plain TypeScript: no React, no React Native, no Agora — the
 * audio engine, the server, the permission prompt and the clock are all handed in, so every path
 * here is unit-tested (tests/voice).
 *
 *   unavailable   voice cannot be used in this game right now (the reason is in `problem`)
 *   idle_muted    voice is on for the room; this phone has not joined it
 *   connecting    joining the channel (muted)
 *   ready_muted   in the channel, listening, microphone not transmitting
 *   transmitting  the button is held and the microphone is being sent
 *   reconnecting  the connection dropped; never shown as transmitting
 *   error         joining or the connection failed; a tap tries again
 *
 * The one rule everything else serves: the microphone transmits only between a press that reached
 * `ready_muted` and the first of release, cancel, blur, background, disconnect, revocation or
 * leaving. Every one of those goes through `stopTransmitting`, which is safe to call at any time
 * and any number of times.
 */
export type VoicePhase = 'unavailable' | 'idle_muted' | 'connecting' | 'ready_muted' | 'transmitting' | 'reconnecting' | 'error';

/** What the screen should explain. Server denials, plus what only the phone can know. */
export type VoiceProblem = VoiceDenial | 'MIC_DENIED' | 'MIC_BLOCKED' | 'CONNECT_FAILED' | 'NEEDS_DEV_BUILD';

export type MicPermission = 'unknown' | 'granted' | 'denied' | 'blocked';

/** How long the button must be held before the microphone opens: long enough that a stray tap sends nothing, short enough to feel immediate. */
export const HOLD_TO_TALK_MS = 120;
/** A join that has not connected after this long is a failure. */
export const JOIN_TIMEOUT_MS = 15_000;
/**
 * The only automatic retry there is: rejoining when the app comes back to the foreground. This many
 * in a row without once connecting, and it stops (the player can still tap). A safety cap, so that
 * nothing which keeps sending the app "to the background" can restart the join for ever.
 */
export const MAX_AUTO_RESUMES = 3;
export const DEFAULT_VOLUME = 100;

export interface VoiceEngineEvents {
  onJoined: () => void;
  onConnection: (state: 'connected' | 'reconnecting' | 'failed') => void;
  onUserJoined: (uid: number) => void;
  onUserLeft: (uid: number) => void;
  /** From the SDK's own remote-audio state: the player is (or is no longer) sending their microphone. */
  onUserSpeaking: (uid: number, speaking: boolean) => void;
  onTokenWillExpire: () => void;
  onTokenExpired: () => void;
}

/** The small surface of the audio SDK this feature uses (src/features/voice/agoraEngine.ts implements it). */
export interface VoiceEngine {
  /** Joins muted. Throws when the SDK refuses outright. */
  join: (params: { token: string; channel: string; uid: number; micAllowed: boolean }, events: VoiceEngineEvents) => void;
  renewToken: (token: string) => void;
  /** Opens or closes the local microphone to the channel. */
  setTransmitting: (on: boolean) => void;
  /** The microphone permission arrived after joining. */
  allowMic: () => void;
  muteRemote: (uid: number, muted: boolean) => void;
  /** 0–100. */
  setRemoteVolume: (uid: number, volume: number) => void;
  /** 0–100, every remote voice. */
  setMasterVolume: (volume: number) => void;
  /** Leaves the channel and frees the SDK. Never throws. */
  leave: () => void;
}

export interface VoiceDeps {
  api: VoiceApi;
  /** A fresh engine, or null when the native module is not in this build (Expo Go, tests). */
  createEngine: () => VoiceEngine | null;
  /** Asks for the microphone if it can still be asked for. */
  requestMic: () => Promise<Exclude<MicPermission, 'unknown'>>;
  notify: (kind: 'info' | 'error', problem: VoiceProblem) => void;
  holdMs?: number;
  joinTimeoutMs?: number;
}

export interface VoicePeer {
  speaking: boolean;
}

export interface VoiceState {
  gameId: string | null;
  /** The server's last word on this room; null until it has answered. */
  room: VoiceRoom | null;
  phase: VoicePhase;
  problem: VoiceProblem | null;
  mic: MicPermission;
  /** Who is in the voice channel besides me, by Agora uid (seat + 1). */
  peers: Record<number, VoicePeer>;
  // Listening preferences: this phone only, this game only, never sent anywhere.
  mutedUids: Record<number, true>;
  muteAll: boolean;
  volumes: Record<number, number>;
  masterVolume: number;
  /** The host's on/off request is in flight. */
  configuring: boolean;
}

const INITIAL: VoiceState = {
  gameId: null,
  room: null,
  phase: 'unavailable',
  problem: null,
  mic: 'unknown',
  peers: {},
  mutedUids: {},
  muteAll: false,
  volumes: {},
  masterVolume: DEFAULT_VOLUME,
  configuring: false,
};

/** Failures that say nothing about whether voice is allowed: try again later. */
const TRANSIENT: readonly VoiceDenial[] = ['NETWORK', 'TIMEOUT', 'SERVER_ERROR', 'RATE_LIMITED'];
/** Denials that mean the room itself no longer has voice. */
const ROOM_OFF: readonly VoiceDenial[] = ['ROOM_VOICE_OFF', 'PUBLIC_GAME'];

const clampVolume = (v: number) => Math.max(0, Math.min(100, Math.round(Number.isFinite(v) ? v : DEFAULT_VOLUME)));

export class VoiceController {
  readonly store = createStore<VoiceState>(() => INITIAL);

  private creds: Credentials | null = null;
  private engine: VoiceEngine | null = null;
  /** Bumped whenever the current connection attempt stops being the current one: late answers and events are dropped. */
  private epoch = 0;
  private gameLive = false;
  private holding = false;
  /** The player joined voice and has not left it: a foreground return reconnects. */
  private wantJoined = false;
  private resumeOnForeground = false;
  private holdTimer: ReturnType<typeof setTimeout> | null = null;
  private joinTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private renewing: Promise<void> | null = null;
  private statusSeq = 0;
  /** Foreground rejoins in a row that have not connected yet (see MAX_AUTO_RESUMES). */
  private autoResumes = 0;

  constructor(private readonly deps: VoiceDeps) {}

  private get state(): VoiceState {
    return this.store.getState();
  }

  private set(patch: Partial<VoiceState>): void {
    this.store.setState(patch);
  }

  private get joined(): boolean {
    return this.engine !== null;
  }

  /** The phase of a phone that is not in the channel. */
  private restingPhase(room: VoiceRoom | null = this.state.room): VoicePhase {
    return room?.enabled && room.available && this.gameLive ? 'idle_muted' : 'unavailable';
  }

  // ---------------------------------------------------------------- lifecycle

  /** This phone is in a game (lobby or table). Asks the server what this room's voice is. */
  attach(creds: Credentials): void {
    const same = this.creds && this.creds.gameId === creds.gameId && this.creds.playerId === creds.playerId && this.creds.token === creds.token;
    if (same) return;
    this.detach();
    this.creds = creds;
    this.set({ gameId: creds.gameId });
    void this.refreshRoom();
  }

  /** The game is gone from this phone (left, finished and closed, signed out): voice goes with it, and so do the preferences. */
  detach(): void {
    this.drop(true);
    this.creds = null;
    this.gameLive = false;
    this.wantJoined = false;
    this.resumeOnForeground = false;
    this.statusSeq += 1;
    this.store.setState(INITIAL, true);
  }

  /** Whether the game is in play and this player is still at the table. Voice exists only then. */
  setGameLive(live: boolean): void {
    if (live === this.gameLive) return;
    this.gameLive = live;
    if (!live) {
      this.wantJoined = false;
      this.resumeOnForeground = false;
      this.drop(true);
      this.set({ phase: 'unavailable', problem: null });
      return;
    }
    if (!this.joined) this.set({ phase: this.restingPhase() });
    // The room's answer changes when the game starts ("starts when the game does" → available).
    void this.refreshRoom();
  }

  /** Asks the server again (on entering a game, when it starts, and when the host changes the setting). */
  async refreshRoom(): Promise<void> {
    const creds = this.creds;
    if (!creds) return;
    const seq = ++this.statusSeq;
    const res = await this.deps.api.status(creds);
    if (seq !== this.statusSeq || this.creds !== creds) return;
    if (!res.ok) return; // keep what we knew; a connected phone is told by its heartbeat
    this.applyRoom(res.room);
  }

  private applyRoom(room: VoiceRoom): void {
    this.set({ room });
    if (this.joined) {
      // Switched off for the room: leave now. Anything else (a cap) is the heartbeat's and the renewal's to enforce.
      if (!room.enabled) this.revoked(room.reason ?? 'ROOM_VOICE_OFF', false);
      return;
    }
    if (this.state.phase === 'connecting') return;
    const resting = this.restingPhase(room);
    // A failed attempt stays "tap to retry" while the room is still open; otherwise the room decides.
    if (this.state.phase === 'error' && resting === 'idle_muted') return;
    this.set({ phase: resting, problem: resting === 'unavailable' && room.enabled ? room.reason : null });
  }

  /** Host only: turn the room's voice on or off. The server decides whether it may be. */
  async setRoomEnabled(enabled: boolean): Promise<boolean> {
    const creds = this.creds;
    if (!creds || this.state.configuring) return false;
    this.set({ configuring: true });
    const res = await this.deps.api.enable(creds, enabled);
    if (this.creds !== creds) return false;
    this.set({ configuring: false });
    if (!res.ok) {
      this.deps.notify('error', res.error.code);
      return false;
    }
    this.statusSeq += 1; // an older status answer must not overwrite this one
    this.applyRoom(res.room);
    return true;
  }

  // ---------------------------------------------------------------- joining and leaving

  /** The player opts in: ask for the microphone (first use), get a token, join muted. */
  async join(): Promise<void> {
    // A join the player asked for starts the count of automatic resumes afresh.
    this.autoResumes = 0;
    await this.start();
  }

  private async start(): Promise<void> {
    const creds = this.creds;
    const phase = this.state.phase;
    if (!creds || this.joined || (phase !== 'idle_muted' && phase !== 'error')) return;
    const epoch = ++this.epoch;
    this.wantJoined = true;
    this.set({ phase: 'connecting', problem: null });

    const mic = await this.deps.requestMic();
    if (epoch !== this.epoch) return;
    this.set({ mic });

    const res = await this.deps.api.join(creds);
    if (epoch !== this.epoch) {
      // Left (or backgrounded) while the token was on its way: the server opened a session nobody is using.
      if (res.ok) void this.deps.api.leave(creds);
      return;
    }
    if (!res.ok) {
      this.failed(res.error.code);
      return;
    }
    const engine = this.deps.createEngine();
    if (!engine) {
      void this.deps.api.leave(creds);
      this.wantJoined = false;
      this.set({ phase: 'unavailable', problem: 'NEEDS_DEV_BUILD' });
      this.deps.notify('info', 'NEEDS_DEV_BUILD');
      return;
    }
    this.engine = engine;
    const { token, channel, uid, heartbeatSeconds } = res.grant;
    try {
      engine.join({ token, channel, uid, micAllowed: mic === 'granted' }, this.events(epoch, heartbeatSeconds));
    } catch {
      this.failed('CONNECT_FAILED');
      return;
    }
    this.joinTimer = setTimeout(() => {
      this.joinTimer = null;
      if (epoch === this.epoch && this.state.phase === 'connecting') this.failed('CONNECT_FAILED');
    }, this.deps.joinTimeoutMs ?? JOIN_TIMEOUT_MS);
  }

  /** "Leave voice": out of the channel, still in the game, free to join again. */
  leaveVoice(): void {
    this.wantJoined = false;
    this.resumeOnForeground = false;
    this.drop(true);
    this.set({ phase: this.restingPhase(), problem: null });
  }

  /** Out of the channel, microphone closed, timers stopped. Safe at any time. */
  private drop(tellServer: boolean): void {
    this.epoch += 1;
    this.holding = false;
    if (this.holdTimer) clearTimeout(this.holdTimer);
    if (this.joinTimer) clearTimeout(this.joinTimer);
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.holdTimer = this.joinTimer = this.heartbeatTimer = null;
    this.renewing = null;
    const engine = this.engine;
    this.engine = null;
    if (engine) {
      try {
        engine.setTransmitting(false);
      } catch {
        // leaving anyway
      }
      engine.leave();
      if (tellServer && this.creds) void this.deps.api.leave(this.creds);
    }
    if (Object.keys(this.state.peers).length) this.set({ peers: {} });
  }

  /** Could not join, or lost the connection for good. */
  private failed(code: VoiceDenial | 'CONNECT_FAILED'): void {
    if (code !== 'CONNECT_FAILED' && !TRANSIENT.includes(code)) {
      this.revoked(code, true);
      return;
    }
    this.drop(true);
    this.set({ phase: this.restingPhase() === 'idle_muted' ? 'error' : 'unavailable', problem: 'CONNECT_FAILED' });
    this.deps.notify('error', 'CONNECT_FAILED');
  }

  /** The server said no (kill switch, cap, room switched off, no longer in the game): stop, leave, say why. */
  private revoked(code: VoiceDenial, tell = true): void {
    this.wantJoined = false;
    this.resumeOnForeground = false;
    this.drop(false);
    const room = this.state.room;
    this.set({
      room: room ? { ...room, available: false, reason: code, enabled: ROOM_OFF.includes(code) ? false : room.enabled } : room,
      phase: 'unavailable',
      problem: code,
    });
    if (tell) this.deps.notify('info', code);
  }

  // ---------------------------------------------------------------- engine events

  private events(epoch: number, heartbeatSeconds: number): VoiceEngineEvents {
    const live = () => epoch === this.epoch && this.engine !== null;
    return {
      onJoined: () => {
        if (!live()) return;
        if (this.joinTimer) clearTimeout(this.joinTimer);
        this.joinTimer = null;
        const engine = this.engine!;
        engine.setTransmitting(false);
        engine.setMasterVolume(this.state.masterVolume);
        this.autoResumes = 0;
        this.set({ phase: 'ready_muted', problem: this.micProblem() });
        if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
        this.heartbeatTimer = setInterval(() => void this.heartbeat(epoch), Math.max(10, heartbeatSeconds) * 1000);
      },
      onConnection: (state) => {
        if (!live()) return;
        if (state === 'reconnecting') {
          // Whatever the finger is doing, nothing is being sent now — and nothing will be until a new press.
          this.stopTransmitting();
          if (this.state.phase !== 'connecting') this.set({ phase: 'reconnecting' });
        } else if (state === 'connected') {
          if (this.state.phase === 'reconnecting') this.set({ phase: 'ready_muted' });
        } else {
          this.failed('CONNECT_FAILED');
        }
      },
      onUserJoined: (uid) => {
        if (!live()) return;
        this.set({ peers: { ...this.state.peers, [uid]: { speaking: this.state.peers[uid]?.speaking ?? false } } });
        this.applyPeer(uid);
      },
      onUserLeft: (uid) => {
        if (!live() || !this.state.peers[uid]) return;
        const { [uid]: _gone, ...rest } = this.state.peers;
        this.set({ peers: rest });
      },
      onUserSpeaking: (uid, speaking) => {
        if (!live()) return;
        const known = this.state.peers[uid];
        if (known?.speaking === speaking) return;
        this.set({ peers: { ...this.state.peers, [uid]: { speaking } } });
        if (!known) this.applyPeer(uid);
      },
      onTokenWillExpire: () => {
        if (live()) void this.renew(epoch);
      },
      onTokenExpired: () => {
        if (live()) void this.renew(epoch);
      },
    };
  }

  /** A new token for the same channel. The server runs every check again; one request at a time. */
  private renew(epoch: number): Promise<void> {
    if (this.renewing) return this.renewing;
    const creds = this.creds;
    if (!creds) return Promise.resolve();
    const run = (async () => {
      const res = await this.deps.api.renew(creds);
      if (epoch !== this.epoch || !this.engine) return;
      if (res.ok) this.engine.renewToken(res.grant.token);
      // Not reachable: the current token still works until it expires, and the SDK asks again then.
      else if (!TRANSIENT.includes(res.error.code)) this.revoked(res.error.code);
    })().finally(() => {
      if (this.renewing === run) this.renewing = null;
    });
    this.renewing = run;
    return run;
  }

  private async heartbeat(epoch: number): Promise<void> {
    const creds = this.creds;
    if (!creds || epoch !== this.epoch || !this.engine) return;
    const res = await this.deps.api.heartbeat(creds);
    if (epoch !== this.epoch || !this.engine || res.ok) return;
    if (res.error.code === 'SESSION_ENDED') void this.renew(epoch);
    else if (!TRANSIENT.includes(res.error.code)) this.revoked(res.error.code);
  }

  // ---------------------------------------------------------------- push-to-talk

  private micProblem(): VoiceProblem | null {
    return this.state.mic === 'blocked' ? 'MIC_BLOCKED' : this.state.mic === 'denied' ? 'MIC_DENIED' : null;
  }

  /** The finger went down on the button. */
  pressIn(): void {
    this.holding = true;
    if (this.holdTimer) clearTimeout(this.holdTimer);
    this.holdTimer = null;
    if (this.state.phase !== 'ready_muted' || !this.engine) return;
    if (this.state.mic !== 'granted') {
      void this.askForMic();
      return;
    }
    const epoch = this.epoch;
    this.holdTimer = setTimeout(() => {
      this.holdTimer = null;
      // Still the same connection, still held, still ready: only then does the microphone open.
      if (epoch !== this.epoch || !this.holding || this.state.phase !== 'ready_muted' || !this.engine) return;
      this.engine.setTransmitting(true);
      this.set({ phase: 'transmitting' });
    }, this.deps.holdMs ?? HOLD_TO_TALK_MS);
  }

  /** The finger came up, slid off, or the touch was cancelled. */
  pressOut(): void {
    this.stopTransmitting();
  }

  /** Closes the microphone, whatever opened it. Called for every release, cancel, blur, background and disconnect. */
  stopTransmitting(): void {
    this.holding = false;
    if (this.holdTimer) clearTimeout(this.holdTimer);
    this.holdTimer = null;
    if (this.state.phase !== 'transmitting') return;
    try {
      this.engine?.setTransmitting(false);
    } finally {
      this.set({ phase: 'ready_muted' });
    }
  }

  /** A completed tap: joins (or retries). It never opens the microphone. */
  tap(): void {
    const { phase, problem, room } = this.state;
    if (phase === 'idle_muted' || phase === 'error') void this.join();
    else if (phase === 'unavailable') this.deps.notify('info', problem ?? room?.reason ?? 'VOICE_DISABLED');
  }

  /** Pressed to talk without the microphone permission: ask (if it can be asked), and say what to do if not. */
  private async askForMic(quiet = false): Promise<void> {
    const epoch = this.epoch;
    const mic = await this.deps.requestMic();
    if (epoch !== this.epoch) return;
    this.set({ mic });
    if (mic === 'granted') {
      this.engine?.allowMic();
      if (this.state.problem === 'MIC_DENIED' || this.state.problem === 'MIC_BLOCKED') this.set({ problem: null });
      return; // the next press talks; this one asked
    }
    const problem = mic === 'blocked' ? 'MIC_BLOCKED' : 'MIC_DENIED';
    this.set({ problem });
    if (!quiet) this.deps.notify('info', problem);
  }

  /** Back from system settings: the permission may have changed there. */
  async recheckMic(): Promise<void> {
    // Only when it was blocked: a merely declined permission is asked for again by a press, not by coming back to the app.
    if (!this.joined || this.state.mic !== 'blocked') return;
    await this.askForMic(true);
  }

  // ---------------------------------------------------------------- app lifecycle

  /** The app is no longer in front (call, lock, switcher, another app): nothing may be sent. */
  appInactive(): void {
    this.stopTransmitting();
  }

  /** The app went to the background: the microphone and the channel are both let go. */
  appBackground(): void {
    this.stopTransmitting();
    if (!this.joined && this.state.phase !== 'connecting') return;
    this.resumeOnForeground = this.wantJoined;
    this.drop(true);
    this.set({ phase: this.restingPhase() });
  }

  /** Back in front: rejoin (muted) if the player was in voice. */
  appForeground(): void {
    if (!this.resumeOnForeground) return;
    this.resumeOnForeground = false;
    if (!this.wantJoined || this.state.phase !== 'idle_muted') return;
    if (this.autoResumes >= MAX_AUTO_RESUMES) {
      // This many resumes in a row never connected. Stop; a tap starts again.
      this.wantJoined = false;
      return;
    }
    this.autoResumes += 1;
    void this.start();
  }

  // ---------------------------------------------------------------- listening preferences (this phone only)

  private effectiveMute(uid: number): boolean {
    return this.state.muteAll || this.state.mutedUids[uid] === true;
  }

  private applyPeer(uid: number): void {
    if (!this.engine) return;
    this.engine.muteRemote(uid, this.effectiveMute(uid));
    const volume = this.state.volumes[uid];
    if (volume !== undefined) this.engine.setRemoteVolume(uid, volume);
  }

  /** Stop (or resume) hearing one player. Their microphone, and what anyone else hears, is untouched. */
  setPeerMuted(uid: number, muted: boolean): void {
    const { [uid]: _was, ...rest } = this.state.mutedUids;
    this.set({ mutedUids: muted ? { ...rest, [uid]: true } : rest });
    if (this.state.peers[uid]) this.applyPeer(uid);
  }

  /** Stop (or resume) hearing everyone. Unmuting everyone keeps each player muted one by one muted. */
  setMuteAll(muteAll: boolean): void {
    this.set({ muteAll });
    for (const uid of Object.keys(this.state.peers)) this.applyPeer(Number(uid));
  }

  setPeerVolume(uid: number, volume: number): void {
    const v = clampVolume(volume);
    this.set({ volumes: { ...this.state.volumes, [uid]: v } });
    if (this.state.peers[uid]) this.engine?.setRemoteVolume(uid, v);
  }

  setMasterVolume(volume: number): void {
    const v = clampVolume(volume);
    this.set({ masterVolume: v });
    this.engine?.setMasterVolume(v);
  }
}
