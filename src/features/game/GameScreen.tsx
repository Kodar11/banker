import { useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { Alert, ScrollView, Text, useWindowDimensions, View, type LayoutChangeEvent } from 'react-native';
import { SafeAreaInsetsContext, SafeAreaView } from 'react-native-safe-area-context';
import { router } from 'expo-router';
import { isPropertyKey, positionOfProperty, spaceAt, spaceName, topUndoable } from '@/engine/index.ts';
import { ConfirmDialog, ConnectionBanner, Sheet } from '@/components/ui';
import { ClassicBoard } from '@/features/board/ClassicBoard';
import { SquareDetails } from '@/features/board/SquareDetails';
import { LoanSheet } from '@/features/loan/LoanSheet';
import { PlayerDetails } from '@/features/player/PlayerDetails';
import { PropertyDeed } from '@/features/player/PropertyDeed';
import { TradeOffers } from '@/features/trade/TradeOffers';
import { TradeSheet } from '@/features/trade/TradeSheet';
import { PayPlayerSheet } from '@/features/transactions/PayPlayerSheet';
import { useGameStore } from '@/store/gameStore';
import { haptics } from '@/utils/haptics';
import { openProperty } from '@/utils/navigation';
import { ActionPanel } from './ActionPanel';
import { AdaptiveActionBar, type BarAction } from './AdaptiveActionBar';
import { ContextualCard } from './ContextualCard';
import { EventFeed, FinishedView, PlayersStrip, UndoBanner } from './GamePanels';
import { needsDecision, pickContext, type ContextTarget } from './gameFocus';
import { planScreenLayout, SCREEN_PADDING, screenGutter } from './layout';
import { MoreActions, type MoreItem } from './MoreActions';
import { TurnActionBar } from './TurnActionBar';
import { useGameAction } from './useGameAction';
import type { GameView } from './useGameView';

/** Information sheets (one at a time, content swapped in place): opening one never changes game state. */
type Panel =
  | { kind: 'square'; index: number }
  | { kind: 'player'; id: string }
  | { kind: 'decision' }
  | { kind: 'requests' }
  | { kind: 'more' }
  | { kind: 'log' }
  | { kind: 'standings' };

/** The existing money/trade sheets, optionally prefilled with a player. */
type Tool = { kind: 'pay'; to: string | null } | { kind: 'trade'; to: string | null } | { kind: 'loan' };

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
  const [panel, setPanel] = useState<Panel | null>(null);
  const [tool, setTool] = useState<Tool | null>(null);
  /** Who the pay / trade sheet was last opened for; changing it remounts (resets) that sheet. */
  const [preselect, setPreselect] = useState<{ pay: string | null; trade: string | null }>({ pay: null, trade: null });
  const [confirmEnd, setConfirmEnd] = useState(false);
  const [dismissedEvent, setDismissedEvent] = useState<string | null>(null);
  const ending = useGameStore((s) => s.pendingAction === 'END_GAME');
  const { state, events } = view.snapshot;
  const me = view.me;

  // ---- Measured layout -----------------------------------------------------
  const screenSize = useWindowDimensions();
  const insets = useContext(SafeAreaInsetsContext) ?? { top: 0, bottom: 0, left: 0, right: 0 };
  const [viewport, setViewport] = useState<{ width: number; height: number } | null>(null);
  const [topHeight, setTopHeight] = useState(EST_TOP);
  const width = viewport?.width ?? screenSize.width - insets.left - insets.right;
  const height = viewport?.height ?? screenSize.height - insets.top - insets.bottom;
  const playing = state.status === 'ACTIVE' && me?.status === 'ACTIVE';
  // Nothing to do but browse (paused, finished, bankrupt): just "More", and the board keeps the room.
  const plan = planScreenLayout({ width, height, topHeight, only: playing ? undefined : 'compact' });
  const onTopLayout = (e: LayoutChangeEvent) => setTopHeight(Math.round(e.nativeEvent.layout.height));

  // ---- Table-side effects (unchanged behaviour) ----------------------------
  // Buzz when my turn starts so players can keep their eyes on the board.
  const wasMyTurn = useRef(view.isMyTurn);
  useEffect(() => {
    if (view.isMyTurn && !wasMyTurn.current) haptics.heavy();
    wasMyTurn.current = view.isMyTurn;
  }, [view.isMyTurn]);

  // Take everyone to the auction when one opens.
  const auctionId = state.auction?.status === 'OPEN' ? state.auction.id : null;
  const shownAuction = useRef<string | null>(null);
  useEffect(() => {
    if (auctionId && shownAuction.current !== auctionId && me && state.auction?.participantIds.includes(me.id)) {
      shownAuction.current = auctionId;
      setPanel(null); // a sheet would cover the auction screen
      haptics.warning();
      router.push(`/auction/${auctionId}`);
    }
  }, [auctionId, me, state.auction?.participantIds]);

  // ---- Navigation between sheets (read-only until an existing flow is opened) ----
  const openSquare = useCallback((index: number) => setPanel({ kind: 'square', index }), []);
  const openPlayer = useCallback((id: string) => setPanel({ kind: 'player', id }), []);
  const openTool = (next: Tool) => {
    setPanel(null);
    if (next.kind !== 'loan') setPreselect((p) => ({ ...p, [next.kind]: next.to }));
    setTool(next);
  };
  const openContext = (target: ContextTarget) => {
    if (target.kind === 'auction') router.push(`/auction/${target.auctionId}`);
    else setPanel(target);
  };

  const last = topUndoable(state);
  const canRequestUndo =
    !!me && !!last && !state.undoRequest && (last.actorId === me.id || last.counterpartyIds.includes(me.id)) && state.status === 'ACTIVE';
  const hasRequests =
    !!me &&
    ((!!state.undoRequest && (state.undoRequest.approverIds.includes(me.id) || state.undoRequest.requestedBy === me.id)) ||
      state.trades.some((t) => t.status === 'PENDING' && (t.toPlayerId === me.id || t.fromPlayerId === me.id)));

  const barActions: BarAction[] = [
    { key: 'properties', icon: '🏘️', label: 'My Properties', testID: 'open-properties', onPress: () => me && openPlayer(me.id) },
    { key: 'trade', icon: '🔄', label: 'Transfer', testID: 'open-trade', hint: 'Offer a trade of properties and money', onPress: () => openTool({ kind: 'trade', to: null }) },
    { key: 'pay', icon: '💸', label: 'Pay Money', testID: 'open-pay', onPress: () => openTool({ kind: 'pay', to: null }) },
    { key: 'loan', icon: '🏦', label: 'Bank / Loan', testID: 'open-loan', onPress: () => openTool({ kind: 'loan' }) },
    {
      key: 'auction',
      icon: '🔨',
      label: 'Auction',
      testID: 'open-auction',
      disabled: !auctionId,
      hint: auctionId ? 'Open the live auction' : 'Starts when a player declines a property',
      onPress: () => auctionId && router.push(`/auction/${auctionId}`),
    },
    { key: 'more', icon: '⋯', label: 'More', testID: 'open-more', hint: 'Mortgage, undo, pause, log and rules', onPress: () => setPanel({ kind: 'more' }) },
  ];

  const moreItems: MoreItem[] = [];
  if (playing && me) {
    moreItems.push(
      { key: 'properties', icon: '🏘️', label: 'My Properties', testID: 'more-properties', onPress: () => openPlayer(me.id) },
      { key: 'trade', icon: '🔄', label: 'Transfer', hint: 'Trade properties and money with a player', testID: 'more-trade', onPress: () => openTool({ kind: 'trade', to: null }) },
      { key: 'pay', icon: '💸', label: 'Pay Money', hint: 'Pay another player', testID: 'more-pay', onPress: () => openTool({ kind: 'pay', to: null }) },
      { key: 'loan', icon: '🏦', label: 'Bank / Loan', hint: 'Borrow or repay', testID: 'more-loan', onPress: () => openTool({ kind: 'loan' }) },
      {
        key: 'auction',
        icon: '🔨',
        label: 'Auction',
        hint: auctionId ? 'Open the live auction' : 'No auction running',
        testID: 'more-auction',
        disabled: !auctionId,
        onPress: () => auctionId && router.push(`/auction/${auctionId}`),
      },
      { key: 'manage', icon: '🏗️', label: 'Mortgage, build or sell', hint: 'Pick one of your properties', testID: 'more-manage', onPress: () => openPlayer(me.id) },
      {
        key: 'undo',
        icon: '↩️',
        label: 'Ask to undo',
        hint: last ? last.description : 'Nothing to undo',
        testID: 'request-undo',
        disabled: !canRequestUndo,
        onPress: () =>
          last &&
          Alert.alert('Ask to undo?', `${last.description}\n\nAnother player must approve. Money is reversed with a new transaction.`, [
            { text: 'Cancel', style: 'cancel' },
            { text: 'Ask', onPress: () => void send({ type: 'REQUEST_UNDO', targetActionId: last.actionId }) },
          ]),
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
  );
  if (view.isHost && state.status !== 'FINISHED') {
    moreItems.push({
      key: 'end',
      icon: '🏆',
      label: 'End game (host)',
      testID: 'end-game-button',
      destructive: true,
      onPress: () => {
        setPanel(null);
        setConfirmEnd(true);
      },
    });
  }

  // ---- Which information sheet is open ---------------------------------------
  const decision = needsDecision(view);
  const panelOpen =
    !!panel &&
    (panel.kind !== 'decision' || decision) &&
    (panel.kind !== 'requests' || hasRequests) &&
    (panel.kind !== 'standings' || state.status === 'FINISHED');
  let panelTitle = '';
  let panelBody: ReactNode = null;
  if (panel && panelOpen) {
    switch (panel.kind) {
      case 'square': {
        const space = spaceAt(panel.index);
        panelTitle = space.kind === 'PROPERTY' ? 'Property' : spaceName(panel.index);
        panelBody = (
          <SquareDetails
            view={view}
            index={panel.index}
            onPlayerPress={openPlayer}
            onManageProperty={(key) => {
              setPanel(null);
              openProperty(key);
            }}
          />
        );
        break;
      }
      case 'player':
        panelTitle = panel.id === me?.id ? 'You' : 'Player';
        panelBody = (
          <PlayerDetails
            view={view}
            playerId={panel.id}
            onPropertyPress={(key) => isPropertyKey(key) && openSquare(positionOfProperty(key))}
            onMakeOffer={(id) => openTool({ kind: 'trade', to: id })}
            onPayMoney={(id) => openTool({ kind: 'pay', to: id })}
            onOpenWallet={(id) => {
              setPanel(null);
              router.push(`/player/${id}`);
            }}
          />
        );
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
        panelBody = <MoreActions items={moreItems} />;
        break;
      case 'log':
        panelTitle = 'Game log';
        panelBody = <EventFeed events={events} limit={30} />;
        break;
      case 'standings':
        panelTitle = 'Final standings';
        panelBody = <FinishedView view={view} />;
        break;
    }
  }

  const context = pickContext(view, dismissedEvent);
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
        <View testID="game-top" onLayout={onTopLayout} style={{ gap: plan.gap }}>
          <ConnectionBanner />
          <View className="flex-row items-baseline justify-between px-1" testID="game-header" accessibilityRole="header">
            <Text className="text-lg font-black tracking-[3px] text-cream">BUSINESS</Text>
            <Text className="text-xs font-bold uppercase tracking-[2px] text-cream/60">Classic · India</Text>
          </View>
          <PlayersStrip view={view} onSelect={openPlayer} />
        </View>
        <TurnActionBar view={view} send={send} dense={plan.dense} height={plan.turnBarHeight} onChoose={() => setPanel({ kind: 'decision' })} />

        <View testID="board-area" style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
          <ClassicBoard state={state} size={plan.board} onSquarePress={openSquare} onTokenPress={openPlayer} />
        </View>

        <ContextualCard item={context} height={plan.contextHeight} onAction={openContext} onDismiss={setDismissedEvent} />

        <AdaptiveActionBar layout={plan.actions} actions={playing ? barActions : barActions.filter((a) => a.key === 'more')} />
      </ScrollView>

      <Sheet visible={panelOpen} title={panelTitle} onClose={() => setPanel(null)} testID={panel ? `sheet-${panel.kind}` : undefined}>
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
      <LoanSheet visible={tool?.kind === 'loan'} onClose={() => setTool(null)} view={view} send={send} />
      <TradeSheet
        key={`trade-${preselect.trade}`}
        visible={tool?.kind === 'trade'}
        initialPlayerId={preselect.trade}
        onClose={() => setTool(null)}
        view={view}
        send={send}
      />
      <ConfirmDialog
        visible={confirmEnd && view.isHost && state.status !== 'FINISHED'}
        icon="🏆"
        title="End Game?"
        message="Are you sure you want to finish this game?"
        detail="Highest net worth wins."
        confirmTitle="End Game"
        destructive
        loading={ending}
        testID="end-game-dialog"
        onCancel={() => setConfirmEnd(false)}
        onConfirm={async () => {
          await send({ type: 'END_GAME' });
          setConfirmEnd(false);
        }}
      />
    </SafeAreaView>
  );
}
