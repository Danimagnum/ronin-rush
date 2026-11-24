'use client';
import { ActionDock, StakeControls } from '@/components/BetPanel';
import { FairnessBar } from '@/components/FairnessBar';
import { GameStage } from '@/components/GameStage';
import { HistoryStrip } from '@/components/HistoryStrip';
import { PlayersPanel } from '@/components/PlayersPanel';
import { BreakReminder } from '@/components/SessionClock';
import { useShell } from '@/components/AppShell';
import { SystemView } from '@/components/SystemView';
import { useGame } from '@/lib/store';

export default function PlayPage() {
  const { audio } = useShell();
  const systemView = useGame((s) => s.systemView);
  return (
    <>
    <h1 className="sr-only">Ronin Rush: live duel</h1>
    {/* Below lg the wrappers vanish (display: contents) so the action dock can stay stuck to the
        bottom of the screen for the whole page, under the thumb. */}
    <div className="flex flex-col gap-4 lg:grid lg:grid-cols-[minmax(0,1fr)_340px] lg:gap-6">
      <div className="contents min-w-0 lg:flex lg:flex-col lg:gap-4">
        <BreakReminder />
        <HistoryStrip />
        <GameStage audio={audio} />
        <div className="contents md:grid md:grid-cols-[minmax(0,1fr)_300px] md:gap-8">
          <StakeControls />
          <ActionDock />
        </div>
        <FairnessBar />
      </div>
      <aside className="flex min-h-[420px] flex-col lg:sticky lg:top-6 lg:h-[calc(100dvh-7rem)]">
        <PlayersPanel />
      </aside>
    </div>
    {systemView ? (
      <div className="mt-6">
        <SystemView />
      </div>
    ) : null}
    </>
  );
}
