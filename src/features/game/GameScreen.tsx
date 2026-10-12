import { useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { ScrollView, Text, useWindowDimensions, View, type LayoutChangeEvent } from 'react-native';
import { SafeAreaInsetsContext, SafeAreaView } from 'react-native-safe-area-context';
import { router, useIsFocused } from 'expo-router';
import {
  configOf,
  durationLimit,
  economyOf,
  endVoteRequestBlocker,
  financialYear,
  hasGameDuration,
  isIntermediate,
  isPropertyKey,
  openEndVote,
  pendingCrisisOf,
  positionOfProperty,
  spaceAt,
  spaceName,
  topUndoable,
  yearProgressPercent,
  type UndoableRecord,
} from '@/engine/index.ts';
import { Button, ConfirmDialog, ConnectionBanner, Sheet } from '@/components/ui';
import { NEW_AUCTION } from '@/features/auction/AuctionView';
import { ClassicBoard } from '@/features/board/ClassicBoard';
import { SquareDetails } from '@/features/board/SquareDetails';
import { FinanceHub, type FinanceTab } from '@/features/finance/FinanceHub';
import { FinanceNotices } from '@/features/finance/FinanceNotices';
import { IntermediateIntro } from '@/features/finance/IntermediateIntro';
import { CrisisNotice, CrisisSettlement } from '@/features/insurance/CrisisSettlement';
import { LessonSuggestion } from '@/features/learning/LessonSuggestion';
import { LoanSheet } from '@/features/loan/LoanSheet';
import { GameConfigSummary } from '@/features/lobby/GameConfigEditor';
import { MyObjective } from '@/features/objectives/ObjectiveCard';
import { ObjectiveReveal, useObjectiveSeen } from '@/features/objectives/ObjectiveReveal';
import { PlayerDetails, PlayerDetailsActions, PlayerDetailsHeader } from '@/features/player/PlayerDetails';
import { ChatBubbles } from '@/features/quickChat/QuickChatOverlays';
import { QuickChatSheet } from '@/features/quickChat/QuickChatSheet';
import { useQuickChat } from '@/features/quickChat/useQuickChat';
import { PropertyDeed } from '@/features/player/PropertyDeed';
import { TradeOffers } from '@/features/trade/TradeOffers';
import { TradeSheet } from '@/features/trade/TradeSheet';
import { PayPlayerSheet } from '@/features/transactions/PayPlayerSheet';
import { PushToTalkButton } from '@/features/voice/PushToTalkButton';
import { useVoice } from '@/features/voice/voice';
import { VoiceSection } from '@/features/voice/VoiceSection';
import { haptics } from '@/utils/haptics';
import { ActionPanel } from './ActionPanel';
import { AdaptiveActionBar, type BarAction } from './AdaptiveActionBar';
import { ContextualCard } from './ContextualCard';
import { RequestEndVoteDialog } from './EndVote';
import { GameLog } from './GameLog';
import { FinishedView, PlayersStrip, UndoBanner } from './GamePanels';
import { GamePlanIntro, useGamePlanSeen } from './GamePlanIntro';
import { needsDecision, pickContext, type ContextTarget } from './gameFocus';
import { leaveGame } from './leaveGame';
import { LeaveGameDialog } from './LeaveGameDialog';
import { planScreenLayout, SCREEN_PADDING, screenGutter, SECTION_GAP, VICTORY_CARD_HEIGHT } from './layout';
import { MoreActions, type MoreItem } from './MoreActions';
import { TurnActionBar } from './TurnActionBar';
import { sendFailure, useGameAction } from './useGameAction';
import type { GameView } from './useGameView';
import { VictoryCard } from './VictoryCard';

/** Information sheets (one at a time, content swapped in place): opening one never changes game state. A property I own is also managed from its sheet. */
type Panel =
  | { kind: 'square'; index: number }
  | { kind: 'player'; id: string }
  | { kind: 'decision' }
  | { kind: 'requests' }
  | { kind: 'more' }
  | { kind: 'log' }
  | { kind: 'standings' }
  | { kind: 'config' }
  | { kind: 'objective' };

/** The existing money/trade sheets, optionally prefilled with a player — and the reactions sheet. One at a time. */
type Tool = { kind: 'pay'; to: string | null } | { kind: 'trade'; to: string | null } | { kind: 'loan'; tab?: FinanceTab } | { kind: 'chat' };

/** The auction this device was last taken to: one push per auction, however many screens are mounted. */
let openedAuctionId: string | null = null;

/** Estimate for header + player strip until the first layout pass reports the measured height. */
const EST_TOP = 82;

/**
 * The digital game table. Top to bottom:
 *   header · players · turn + THE primary action · BOARD · contextual card · action area.
 * The board is the hero and is interactive but read-only (taps open details).
 * Every gameplay change still goes through useGameAction → the server.
 */
export function GameScreen({ view }: { view: GameView }) {
  const send = useGameAction();
  /** The open sheet, and the auction (if any) that was running when it was opened. */
  const [panelState, setPanelState] = useState<{ panel: Panel; auctionId: string | null } | null>(null);
  const [tool, setTool] = useState<Tool | null>(null);
  // Quick reactions and messages: sent around the game, never through it (no action, no version, no turn).
  const chat = useQuickChat({ onSent: () => setTool(null) });
  /** Who the pay / trade sheet was last opened for; changing it remounts (resets) that sheet. */
  const [preselect, setPreselect] = useState<{ pay: string | null; trade: string | null }>({ pay: null, trade: null });
  const [confirmVote, setConfirmVote] = useState(false);
  const [confirmLeave, setConfirmLeave] = useState(false);
  /** The action the player is being asked to confirm an undo request for (asked from the More sheet). */
  const [undoAsk, setUndoAsk] = useState<{ record: UndoableRecord; busy: boolean; error: string | null } | null>(null);
  // The host turned voice on for this private room (the server's flag; a matchmade game never has it).
  const voiceRoom = useVoice((s) => s.room?.enabled === true);
  /** False while another screen (auction, wallet, settings) covers the table: a held mic button is released. */
  const tableFocused = useIsFocused();
  const { state, events } = view.snapshot;
  const me = view.me;
  // Capital with secret objectives only, and only my own: this phone holds nobody else's.
  const hasObjective = !!me && !!state.objectives?.assignments[me.id];
  const objectiveSeen = useObjectiveSeen(state.id, hasObjective && me ? me.id : null);
  // A hosted game runs for a chosen number of financial years and ends by vote; a matchmade game has neither.
  const timed = hasGameDuration(state);
  const planSeen = useGamePlanSeen(state.id, timed && me ? me.id : null);
  /** A vote on ending the game is open: its card (EndVoteHost, above every screen) has the table until it is settled. */
  const voting = !!openEndVote(state);
  /** "Later" on the reveal: not offered again until the game is next opened. */
  const [revealLater, setRevealLater] = useState(false);
  /** The Capital introduction has finished (or was not needed): the reveal waits its turn behind it. */
  const [introSettled, setIntroSettled] = useState(false);
  const settleIntro = useCallback(() => setIntroSettled(true), []);
  const auctionId = state.auction?.status === 'OPEN' ? state.auction.id : null;
  // Capital Mode: with no auction running, the Auction button is where a player puts a property of theirs up for sale.
  const canListProperty = !auctionId && isIntermediate(state) && state.status === 'ACTIVE' && me?.status === 'ACTIVE';
  const openAuction = () => {
    if (auctionId) router.push(`/auction/${auctionId}`);
    else if (canListProperty) router.push(`/auction/${NEW_AUCTION}`);
  };
  // A sheet would cover the auction screen, so a sheet opened before an auction started is closed by it.
  const panel = panelState && (!auctionId || panelState.auctionId === auctionId) ? panelState.panel : null;
  const setPanel = useCallback(
    (next: Panel | null) => {
      setPanelState(next ? { panel: next, auctionId } : null);
      setUndoAsk(null); // a confirmation belongs to the sheet it was opened from
      setConfirmLeave(false);
      setConfirmVote(false);
    },
    [auctionId],
  );

  // ---- Measured layout -----------------------------------------------------
  const screenSize = useWindowDimensions();
  const insets = useContext(SafeAreaInsetsContext) ?? { top: 0, bottom: 0, left: 0, right: 0 };
  const [viewport, setViewport] = useState<{ width: number; height: number } | null>(null);
  const [topHeight, setTopHeight] = useState(EST_TOP);
  const width = viewport?.width ?? screenSize.width - insets.left - insets.right;
  const height = viewport?.height ?? screenSize.height - insets.top - insets.bottom;
  const playing = state.status === 'ACTIVE' && me?.status === 'ACTIVE';
  // Nothing to do but browse (paused, finished, bankrupt): just "More", and the board keeps the room.
  const plan = planScreenLayout({ width, height, topHeight, only: playing ? undefined : 'compact', context: state.status === 'FINISHED' ? VICTORY_CARD_HEIGHT : undefined });
  const onTopLayout = (e: LayoutChangeEvent) => setTopHeight(Math.round(e.nativeEvent.layout.height));

  // ---- Table-side effects (unchanged behaviour) ----------------------------
  // Buzz when my turn starts so players can keep their eyes on the board.
  const wasMyTurn = useRef(view.isMyTurn);
  useEffect(() => {
    if (view.isMyTurn && !wasMyTurn.current) haptics.heavy();
    wasMyTurn.current = view.isMyTurn;
  }, [view.isMyTurn]);

  // Game over → Home, once: a second tap must not navigate again.
  const leaving = useRef(false);
  const returnHome = () => {
    if (leaving.current) return;
    leaving.current = true;
    leaveGame();
  };

  // Take everyone to the auction when one opens.
  useEffect(() => {
    if (auctionId && openedAuctionId !== auctionId && me && state.auction?.participantIds.includes(me.id)) {
      openedAuctionId = auctionId;
      haptics.warning();
      router.push(`/auction/${auctionId}`);
    }
  }, [auctionId, me, state.auction?.participantIds]);

  // ---- Navigation between sheets (read-only until an existing flow is opened) ----
  const openSquare = useCallback((index: number) => setPanel({ kind: 'square', index }), [setPanel]);
  const openPlayer = useCallback((id: string) => setPanel({ kind: 'player', id }), [setPanel]);
  /** The full wallet page (cash, properties, loans, history). "My Properties" goes straight here, with no sheet in between. */
  const openWallet = (id: string) => {
    setPanel(null);
    router.push(`/player/${id}`);
  };
  const openTool = (next: Tool) => {
    setPanel(null);
    if (next.kind === 'pay' || next.kind === 'trade') setPreselect((p) => ({ ...p, [next.kind]: next.to }));
    if (next.kind === 'chat') chat.clearBlocked();
    setTool(next);
  };
  const openContext = (target: ContextTarget) => {
    if (target.kind === 'auction') router.push(`/auction/${target.auctionId}`);
    else if (target.kind === 'bank') openTool({ kind: 'loan', tab: 'loans' });
    else setPanel(target);
  };

  // Capital Mode only (null in a Classic game): the economy behind the year indicator, the bank and its notices.
  const eco = economyOf(state);
  // A crisis bill of mine that is not settled yet: until it is, the table shows that and nothing else.
  const myCrisis = playing && me ? pendingCrisisOf(state, me.id) : null;

  const last = topUndoable(state);
  const canRequestUndo =
    !!me && !!last && !state.undoRequest && (last.actorId === me.id || last.counterpartyIds.includes(me.id)) && state.status === 'ACTIVE';
  const requestUndo = async () => {
    if (!undoAsk || undoAsk.busy) return;
    const { record } = undoAsk;
    setUndoAsk({ record, busy: true, error: null });
    const failure = sendFailure(await send({ type: 'REQUEST_UNDO', targetActionId: record.actionId }, { silent: true }));
    // Asked: back to the table, where the card now says the request is waiting for approval.
    if (failure === null) setPanel(null);
    // Still this dialog (not cancelled meanwhile, e.g. by an auction closing the sheet): keep it open to retry.
    else setUndoAsk((now) => (now?.record.actionId === record.actionId ? { record, busy: false, error: failure } : now));
  };
  const hasRequests =
    !!me &&
    ((!!state.undoRequest && (state.undoRequest.approverIds.includes(me.id) || state.undoRequest.requestedBy === me.id)) ||
      state.trades.some((t) => t.status === 'PENDING' && (t.toPlayerId === me.id || t.fromPlayerId === me.id)));

  const barActions: BarAction[] = [
    { key: 'properties', icon: 'properties', label: 'My Properties', testID: 'open-properties', hint: 'Your cash, properties, loans and history', onPress: () => me && openWallet(me.id) },
    { key: 'trade', icon: 'transfer', label: 'Transfer', testID: 'open-trade', hint: 'Offer a trade of properties and money', onPress: () => openTool({ kind: 'trade', to: null }) },
    // Opens the sheet only: nothing is sent until a reaction or message is tapped. (Pay Money is in More, and on every player's sheet.)
    { key: 'chat', icon: 'chat', label: 'Chat / React', testID: 'open-chat', hint: 'Send a quick reaction or message to everyone', onPress: () => openTool({ kind: 'chat' }) },
    { key: 'loan', icon: 'bank', label: 'Bank / Loan', testID: 'open-loan', onPress: () => openTool({ kind: 'loan' }) },
    // A voice room has push-to-talk here; Auction is then in More (and still opens by itself when one starts).
    voiceRoom
      ? {
          key: 'voice',
          icon: 'mic',
          label: 'Push to talk',
          testID: 'push-to-talk',
          onPress: () => undefined,
          render: ({ layout, height }) => <PushToTalkButton layout={layout} height={height} focused={tableFocused} />,
        }
      : {
          key: 'auction',
          icon: 'auction',
          label: 'Auction',
          testID: 'open-auction',
          disabled: !auctionId && !canListProperty,
          hint: auctionId ? 'Open the live auction' : canListProperty ? 'Auction one of your properties' : 'Starts when a player declines a property',
          onPress: openAuction,
        },
    { key: 'more', icon: 'more', label: 'More', testID: 'open-more', hint: `${hasObjective ? 'Your secret objective, ' : ''}${voiceRoom ? 'auction, voice settings, ' : ''}mortgage, undo, pause, log and rules`.replace(/^./, (c) => c.toUpperCase()), onPress: () => setPanel({ kind: 'more' }) },
  ];

  const openObjective = () => {
    objectiveSeen.markSeen();
    setPanel({ kind: 'objective' });
  };
  const moreItems: MoreItem[] = [];
  // First in the list, so it is never below the fold. The label and hint say nothing about which objective it is.
  if (hasObjective) {
    moreItems.push({ key: 'objective', icon: '🎯', label: 'My secret objective', hint: 'Only you can see this', testID: 'open-objective', onPress: openObjective });
  }
  if (playing && me) {
    moreItems.push(
      { key: 'properties', icon: '🏠', label: 'My Properties', testID: 'more-properties', hint: 'Cash, properties, loans and history', onPress: () => openWallet(me.id) },
      { key: 'trade', icon: '🤝', label: 'Transfer', hint: 'Trade properties and money with a player', testID: 'more-trade', onPress: () => openTool({ kind: 'trade', to: null }) },
      { key: 'pay', icon: '💰', label: 'Pay Money', hint: 'Pay another player', testID: 'more-pay', onPress: () => openTool({ kind: 'pay', to: null }) },
      // Also here, for the screens too short to show it in the bar.
      { key: 'chat', icon: '💬', label: 'Chat / React', hint: 'Quick reactions and messages to everyone', testID: 'more-chat', onPress: () => openTool({ kind: 'chat' }) },
      { key: 'loan', icon: '🏦', label: 'Bank / Loan', hint: eco ? 'Loans, payments and credit score' : 'Borrow or repay', testID: 'more-loan', onPress: () => openTool({ kind: 'loan' }) },
      // Capital Mode with insurance only: a Classic game never lists it.
      ...(eco?.insurance
        ? [
            {
              key: 'insurance',
              icon: '🛡️',
              label: 'Property Insurance',
              hint: 'Premiums, your policies and crises',
              testID: 'more-insurance',
              onPress: () => {
                setPanel(null);
                router.push('/insurance');
              },
            },
          ]
        : []),
      {
        key: 'auction',
        icon: '🔨',
        label: 'Auction',
        hint: auctionId ? 'Open the live auction' : canListProperty ? 'Auction one of your properties' : 'No auction running',
        testID: 'more-auction',
        disabled: !auctionId && !canListProperty,
        onPress: () => {
          if (!auctionId) setPanel(null);
          openAuction();
        },
      },
      { key: 'manage', icon: '🏗️', label: 'Mortgage, build or sell', hint: 'Pick one of your properties', testID: 'more-manage', onPress: () => openWallet(me.id) },
      {
        key: 'undo',
        icon: '↩️',
        label: 'Ask to undo',
        hint: last ? last.description : 'Nothing to undo',
        testID: 'request-undo',
        disabled: !canRequestUndo,
        onPress: () => last && setUndoAsk({ record: last, busy: false, error: null }),
      },
      {
        key: 'pause',
        icon: '⏸️',
        label: 'Pause game',
        testID: 'pause-button',
        onPress: () => {
          setPanel(null);
          void send({ type: 'PAUSE_GAME' });
        },
      },
    );
  }
  moreItems.push(
    { key: 'config', icon: '⚙️', label: 'Game settings', hint: 'The rules this game was started with', testID: 'open-config', onPress: () => setPanel({ kind: 'config' }) },
    { key: 'log', icon: '📜', label: 'Game log', hint: 'What happened so far', testID: 'open-log', onPress: () => setPanel({ kind: 'log' }) },
    {
      key: 'rules',
      icon: '📖',
      label: 'House rules & settings',
      testID: 'open-rules',
      onPress: () => {
        setPanel(null);
        router.push('/settings');
      },
    },
    {
      key: 'learning',
      icon: '🎓',
      label: 'Financial Learning',
      hint: 'Short money stories. They never change this game',
      testID: 'open-learning',
      onPress: () => {
        setPanel(null);
        router.push('/learning');
      },
    },
  );
  // Any player may walk away. Nobody — the host included — ends the game for everyone: that takes a vote (below).
  if (me && state.status !== 'FINISHED') {
    moreItems.push({ key: 'leave', icon: '🚪', label: 'Leave game', hint: 'Return to the home screen', testID: 'leave-game-button', onPress: () => setConfirmLeave(true) });
  }
  // Hosted games only: a matchmade game has no duration and no votes, so it never lists this.
  if (me?.status === 'ACTIVE' && timed && state.status !== 'FINISHED') {
    // The server's own rule, so the button is offered exactly when the request would be accepted.
    const blocked = endVoteRequestBlocker(state, me.id);
    moreItems.push({
      key: 'end-vote',
      icon: '🗳️',
      label: 'Request End-Game Vote',
      hint: blocked ?? 'Ask all active players to vote on ending the match.',
      hintLines: 2,
      testID: 'request-end-vote',
      disabled: !!blocked,
      onPress: () => setConfirmVote(true),
    });
  }

  // ---- Which information sheet is open ---------------------------------------
  const decision = needsDecision(view);
  const panelOpen =
    !!panel &&
    (panel.kind !== 'decision' || decision) &&
    (panel.kind !== 'requests' || hasRequests) &&
    (panel.kind !== 'standings' || state.status === 'FINISHED') &&
    (panel.kind !== 'objective' || hasObjective);
  let panelTitle = '';
  let panelBody: ReactNode = null;
  let panelHeader: ReactNode = null;
  let panelFooter: ReactNode = null;
  if (panel && panelOpen) {
    switch (panel.kind) {
      case 'square': {
        const space = spaceAt(panel.index);
        panelTitle = space.kind === 'PROPERTY' ? 'Property' : spaceName(panel.index);
        panelBody = <SquareDetails view={view} index={panel.index} onPlayerPress={openPlayer} />;
        break;
      }
      case 'player':
        panelTitle = panel.id === me?.id ? 'You' : 'Player';
        panelHeader = <PlayerDetailsHeader view={view} playerId={panel.id} />;
        panelBody = (
          <PlayerDetails
            view={view}
            playerId={panel.id}
            onPropertyPress={(key) => isPropertyKey(key) && openSquare(positionOfProperty(key))}
            onOpenWallet={openWallet}
          />
        );
        // Dealing is with someone else; my own sheet only offers my objective (a spectator's view has no pinned actions).
        if (me && panel.id === me.id && hasObjective) {
          panelFooter = <Button size="md" variant="secondary" title="🎯 My secret objective" testID="player-open-objective" onPress={openObjective} />;
        } else if (me && panel.id !== me.id) {
          panelFooter = (
            <PlayerDetailsActions
              view={view}
              playerId={panel.id}
              onMakeOffer={(id) => openTool({ kind: 'trade', to: id })}
              onPayMoney={(id) => openTool({ kind: 'pay', to: id })}
            />
          );
        }
        break;
      case 'decision': {
        const pending = state.turn.pending;
        panelTitle = 'Your move';
        panelBody = (
          <>
            <ActionPanel view={view} send={send} onOpenLoan={() => openTool({ kind: 'loan' })} />
            {pending?.kind === 'BUY' ? <PropertyDeed state={state} propertyKey={pending.propertyKey} playerName={view.playerName} /> : null}
          </>
        );
        break;
      }
      case 'requests':
        panelTitle = 'Offers & requests';
        panelBody = (
          <>
            <UndoBanner view={view} send={send} />
            <TradeOffers view={view} send={send} />
          </>
        );
        break;
      case 'more':
        panelTitle = 'More';
        panelBody = (
          <>
            {/* Only in a voice room, and only at the table: collapsed to one row until opened. */}
            {playing ? <VoiceSection players={state.players} meId={me?.id ?? null} /> : null}
            <MoreActions items={moreItems} />
            {/* Inside the sheet, so it opens above it and Cancel returns to the same More list. */}
            <ConfirmDialog
              visible={!!undoAsk}
              title="Request undo?"
              summary={undoAsk?.record.description}
              message="Another player must approve this request."
              detail="If approved, it is reversed with a new transaction. Nothing changes until then."
              confirmTitle="Request undo"
              intent="warning"
              loading={undoAsk?.busy}
              error={undoAsk?.error}
              testID="undo-dialog"
              onCancel={() => setUndoAsk(null)}
              onConfirm={requestUndo}
            />
            <LeaveGameDialog visible={confirmLeave} onClose={() => setConfirmLeave(false)} />
            <RequestEndVoteDialog
              visible={confirmVote}
              players={state.players.filter((p) => p.status === 'ACTIVE').length}
              onClose={() => setConfirmVote(false)}
              // Asked: back to the table, where the vote now opens for everyone.
              onRequested={() => setPanel(null)}
            />
          </>
        );
        break;
      case 'log':
        panelTitle = 'Game log';
        panelBody = <GameLog events={events} players={state.players} limit={30} />;
        break;
      case 'standings':
        panelTitle = 'Final Standings';
        panelBody = (
          <>
            <FinishedView view={view} />
            {/* Optional and dismissible; the standings above never wait for it. */}
            <LessonSuggestion
              onOpen={(lessonId) => {
                setPanel(null);
                router.push(`/learning/${lessonId}`);
              }}
            />
          </>
        );
        break;
      case 'config':
        panelTitle = 'Game settings';
        panelBody = <GameConfigSummary mode={state.mode} config={configOf(state)} timed={timed} title="This game" note="Locked when the game started. The same for every player." />;
        break;
      case 'objective':
        panelTitle = 'My secret objective';
        panelBody = <MyObjective view={view} />;
        break;
    }
  }

  // The opening sequence, each step once and never over another sheet or dialog: the Capital introduction
  // (once per device), then this game's plan — how long it runs and how it ends — then my secret objective.
  const introPending = !!eco && playing && !introSettled;
  const covered = panelOpen || !!tool || !!auctionId || confirmLeave || introPending || voting;
  // Until storage has answered, the plan might still be due: the reveal waits for it rather than jump ahead.
  const planPending = timed && playing && planSeen.seen !== true;
  const planVisible = planPending && planSeen.seen === false && !covered;
  const revealVisible = hasObjective && state.status !== 'FINISHED' && objectiveSeen.seen === false && !revealLater && !(covered || planPending);

  const context = pickContext(view);
  const gutter = screenGutter(width);

  return (
    <SafeAreaView testID="game-screen" className="flex-1 bg-felt" edges={['top', 'bottom', 'left', 'right']}>
      <ScrollView
        testID="game-scroll"
        onLayout={(e) => {
          const { width: w, height: h } = e.nativeEvent.layout;
          setViewport((v) => (v && v.width === Math.round(w) && v.height === Math.round(h) ? v : { width: Math.round(w), height: Math.round(h) }));
        }}
        bounces={false}
        showsVerticalScrollIndicator={false}
        contentContainerStyle={{ flexGrow: 1, paddingHorizontal: gutter, paddingTop: SCREEN_PADDING.top, paddingBottom: SCREEN_PADDING.bottom, gap: plan.gap }}
      >
        {/* A fixed gap in here: this block's measured height feeds the plan, so it must not depend on the plan's spare height. */}
        <View testID="game-top" onLayout={onTopLayout} style={{ gap: SECTION_GAP[plan.dense ? 'dense' : 'normal'] }}>
          <ConnectionBanner />
          <View className="flex-row items-baseline justify-between px-1" testID="game-header" accessibilityRole="header">
            <Text className="text-lg font-black tracking-[3px] text-cream">BUSINESS</Text>
            {eco ? (
              <Text
                className="text-xs font-bold uppercase tracking-[2px] text-cream/80"
                testID="year-indicator"
                accessibilityLabel={`Capital Mode, financial year ${eco.year}${timed ? ` of ${durationLimit(state)}` : ''}, ${yearProgressPercent(eco)} percent through`}
              >
                Capital · Year {eco.year}
                {timed ? ` of ${durationLimit(state)}` : ''}
              </Text>
            ) : timed && state.status !== 'FINISHED' ? (
              // Classic counts financial years only to know when the game is over: the same clock, no economy behind it.
              <Text
                className="text-xs font-bold uppercase tracking-[2px] text-cream/80"
                testID="duration-indicator"
                accessibilityLabel={`Classic Mode, financial year ${financialYear(state)} of ${durationLimit(state)}`}
              >
                Classic · Year {financialYear(state)} of {durationLimit(state)}
              </Text>
            ) : (
              <Text className="text-xs font-bold uppercase tracking-[2px] text-cream/60">{isIntermediate(state) ? 'Capital · India' : 'Classic · India'}</Text>
            )}
          </View>
          <View>
            <PlayersStrip view={view} onSelect={openPlayer} />
            <ChatBubbles players={state.players} meId={me?.id ?? null} />
          </View>
        </View>
        {myCrisis ? (
          // Instead of the board and its actions — not over them — so there is nothing underneath to tap.
          <CrisisSettlement
            view={view}
            crisis={myCrisis}
            send={send}
            onOpenLoan={() => openTool({ kind: 'loan', tab: 'borrow' })}
            onOpenProperties={() => me && openWallet(me.id)}
            onOpenMore={() => setPanel({ kind: 'more' })}
          />
        ) : (
          <>
            <TurnActionBar view={view} send={send} dense={plan.dense} height={plan.turnBarHeight} onChoose={() => setPanel({ kind: 'decision' })} />

            {/*
              The board has ONE size: the planned square, and its slot is exactly that tall — no slack
              above or below it. (A growing slot put a tall phone's spare height around the board as two
              empty bands; a `flex: 1` slot let Yoga collapse it below the board on a tight screen.)
            */}
            <View testID="board-area" style={{ flexShrink: 0, height: plan.board, alignItems: 'center' }}>
              <ClassicBoard state={state} size={plan.board} onSquarePress={openSquare} onTokenPress={openPlayer} />
            </View>

            {state.status === 'FINISHED' ? (
              // The result takes the card's place: it stays mounted under the standings sheet, so its one celebration is never replayed.
              <VictoryCard view={view} height={plan.contextHeight} dense={plan.dense} onStandings={() => setPanel({ kind: 'standings' })} />
            ) : (
              <ContextualCard item={context} height={plan.contextHeight} onAction={openContext} />
            )}

            {/* Any height the sections could not use sits here, so the actions stay at the bottom of the screen. */}
            <View testID="action-area" style={{ flexGrow: 1, justifyContent: 'flex-end' }}>
              {state.status === 'FINISHED' ? (
                // The game is over: the way out is Home (which has Create and Join), with nothing of this game kept on this phone.
                <View testID="game-over-actions" style={{ flexDirection: 'row', gap: 6, minHeight: plan.actionButtonHeight }}>
                  <Button className="flex-1 px-2" size="sm" title="Return to Home" testID="return-home-button" onPress={returnHome} />
                  <Button className="px-3" size="sm" variant="ghost" title="More" testID="open-more" onPress={() => setPanel({ kind: 'more' })} />
                </View>
              ) : (
                <AdaptiveActionBar layout={plan.actions} buttonHeight={plan.actionButtonHeight} actions={playing ? barActions : barActions.filter((a) => a.key === 'more')} />
              )}
            </View>
          </>
        )}
      </ScrollView>

      <Sheet visible={panelOpen} title={panelTitle} header={panelHeader} footer={panelFooter} onClose={() => setPanel(null)} testID={panel ? `sheet-${panel.kind}` : undefined}>
        {panelBody}
      </Sheet>
      <PayPlayerSheet
        key={`pay-${preselect.pay}`}
        visible={tool?.kind === 'pay'}
        initialPlayerId={preselect.pay}
        onClose={() => setTool(null)}
        view={view}
        send={send}
      />
      <QuickChatSheet visible={tool?.kind === 'chat' && playing} onClose={() => setTool(null)} onSend={chat.send} cooling={chat.cooling} blocked={chat.blocked} />
      {/* Classic keeps its loan sheet. Capital opens the bank from the same Bank / Loan button. */}
      {eco ? (
        <FinanceHub visible={tool?.kind === 'loan'} initialTab={tool?.kind === 'loan' ? tool.tab : undefined} onClose={() => setTool(null)} view={view} send={send} />
      ) : (
        <LoanSheet visible={tool?.kind === 'loan'} onClose={() => setTool(null)} view={view} send={send} />
      )}
      {eco && playing ? (
        <FinanceNotices
          view={view}
          eco={eco}
          suspended={panelOpen || !!tool || !!auctionId || confirmLeave || voting || planVisible || revealVisible || !!myCrisis}
          onOpenLoans={() => openTool({ kind: 'loan', tab: 'loans' })}
        />
      ) : null}
      {eco?.insurance ? <CrisisNotice view={view} suspended={panelOpen || !!tool || !!auctionId || confirmLeave || voting || planVisible || revealVisible || introPending} /> : null}
      {eco && playing ? <IntermediateIntro onSettled={settleIntro} /> : null}
      {planVisible ? <GamePlanIntro state={state} onDone={planSeen.markSeen} /> : null}
      {revealVisible ? <ObjectiveReveal view={view} onLater={() => setRevealLater(true)} onSeen={objectiveSeen.markSeen} /> : null}
      <TradeSheet
        key={`trade-${preselect.trade}`}
        visible={tool?.kind === 'trade'}
        initialPlayerId={preselect.trade}
        onClose={() => setTool(null)}
        view={view}
        send={send}
      />
    </SafeAreaView>
  );
}
