

import { motion } from "framer-motion";
import { ActivityFeed } from "@/components/activity-feed";
import { AlertBanner } from "@/components/alert-banner";
import { CoopSchematic } from "@/components/coop-schematic";
import { useCoop } from "@/components/coop-provider";
import { DoorCard, NestCard, QuickControls } from "@/components/dash-rail";
import { MiniEggChart } from "@/components/egg-chart";
import { Gauge } from "@/components/gauge";
import { SensorStrip } from "@/components/sensor-strip";
import { Panel, Skeleton } from "@/components/ui";
import { clockToHHMM } from "@/lib/format";

function greeting() {
  const h = new Date().getHours();
  if (h < 5) return "Still up, keeper?";
  if (h < 12) return "Good morning, keeper";
  if (h < 18) return "Good afternoon, keeper";
  return "Good evening, keeper";
}

export default function Dashboard() {
  const { snap, patchDevice, collectEggs } = useCoop();

  if (!snap) {
    return (
      <div className="space-y-5">
        <Skeleton className="h-24 w-full" />
        <div className="grid grid-cols-12 gap-5">
          <Skeleton className="col-span-12 h-[420px] xl:col-span-8" />
          <div className="col-span-12 space-y-5 xl:col-span-4">
            <Skeleton className="h-36" />
            <Skeleton className="h-40" />
            <Skeleton className="h-40" />
          </div>
        </div>
      </div>
    );
  }

  const { state, devices } = snap;
  const d = (key: string) => devices.find((x) => x.key === key);
  const tMin = Number(snap.settings.tempMin ?? 16);
  const tMax = Number(snap.settings.tempMax ?? 26);
  const nh3Max = Number(snap.settings.ammoniaMax ?? 20);

  return (
    <div>
      <AlertBanner />

      {/* hero header */}
      <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
        <div>
          <div className="tick-label mb-2">overview · live systems</div>
          <h1 className="font-display text-[34px] font-semibold leading-[1.05] tracking-tight text-cream lg:text-[40px]">
            {greeting()}.
            <span className="block text-[19px] font-normal italic text-dim lg:text-[21px]">
              {snap.henStats.laying} of {snap.henStats.total} hens are laying — coop day {snap.state.dayIndex + 1}, {clockToHHMM(state.clockMinutes)}.
            </span>
          </h1>
        </div>
        <div className="flex items-center gap-2">
          <span className="pulse-dot inline-block h-2 w-2 rounded-full bg-sage text-sage" />
          <span className="font-mono text-[11px] tracking-[0.2em] text-dim">TELEMETRY LIVE · 3s REFRESH</span>
        </div>
      </div>

      {/* schematic + right rail */}
      <div className="grid grid-cols-12 gap-5">
        <motion.div
          initial={{ opacity: 0, y: 14 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5 }}
          className="panel panel-hover col-span-12 overflow-hidden p-3 xl:col-span-8"
        >
          <CoopSchematic
            door={d("door")?.on ?? false}
            heater={d("heater")?.on ?? false}
            fan={d("fan")?.on ?? false}
            lights={d("lights")?.on ?? false}
            lightValue={d("lights")?.value ?? 100}
            lightLevel={state.lightLevel}
            water={state.water}
            feed={state.feed}
            eggs={state.uncollectedEggs}
            clock={state.clockMinutes}
            temp={state.temperature}
            humidity={state.humidity}
            henNames={[]}
            onToggle={(key) => {
              const dev = d(key);
              if (dev) patchDevice(key, { on: !dev.on, mode: "manual" });
            }}
            onCollectEggs={collectEggs}
            onDispense={(key) => patchDevice(key, { dispense: true })}
          />
        </motion.div>

        <motion.div
          initial={{ opacity: 0, y: 14 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5, delay: 0.08 }}
          className="col-span-12 flex flex-col gap-5 xl:col-span-4"
        >
          <DoorCard />
          <NestCard />
          <QuickControls />
        </motion.div>
      </div>

      {/* sensors */}
      <motion.div
        initial={{ opacity: 0, y: 14 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.5, delay: 0.14 }}
        className="mt-5"
      >
        <SensorStrip state={state} settings={snap.settings} />
      </motion.div>

      {/* gauges + eggs + activity */}
      <motion.div
        initial={{ opacity: 0, y: 14 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.5, delay: 0.2 }}
        className="mt-5 grid grid-cols-12 gap-5"
      >
        <Panel title="climate core" className="col-span-12 lg:col-span-5">
          <div className="flex flex-wrap items-start justify-around gap-2">
            <Gauge
              value={state.temperature}
              min={0}
              max={40}
              unit="°C"
              label="temperature"
              sub={`band ${tMin}–${tMax}°`}
              zones={[
                { to: tMin, color: "#7fa8c9" },
                { to: tMax, color: "#a3b86b" },
                { to: 40, color: "#e2633c" },
              ]}
            />
            <Gauge
              value={state.ammonia}
              min={0}
              max={32}
              unit="ppm"
              label="ammonia"
              sub={`limit ${nh3Max} ppm`}
              zones={[
                { to: nh3Max, color: "#a3b86b" },
                { to: 27, color: "#f2a93b" },
                { to: 32, color: "#e2633c" },
              ]}
              digits={0}
            />
          </div>
        </Panel>

        <div className="col-span-12 lg:col-span-4">
          <MiniEggChart data={snap.avg14} />
        </div>

        <div className="col-span-12 lg:col-span-3">
          <ActivityFeed events={snap.recentEvents} limit={7} />
        </div>
      </motion.div>
    </div>
  );
}
