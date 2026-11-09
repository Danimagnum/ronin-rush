'use client';
import { BetPanel } from '@/components/BetPanel';
import { FairnessBar } from '@/components/FairnessBar';
import { GameStage } from '@/components/GameStage';
import { HistoryStrip } from '@/components/HistoryStrip';
import { PlayersPanel } from '@/components/PlayersPanel';
import { BreakReminder } from '@/components/SessionClock';
import { useShell } from '@/components/AppShell';
import { SystemView } from '@/components/SystemView';
import { useGame } from '@/lib/store';

export default function PlayPage() {
  const { audio, requestAuth } = useShell();
  const systemView = useGame((s) => s.systemView);
  return (
    <>
    <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_340px] lg:gap-6">
      <div className="flex min-w-0 flex-col gap-4">
        <BreakReminder />
        <HistoryStrip />
        <GameStage audio={audio} />
        <BetPanel onNeedAuth={requestAuth} />
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
