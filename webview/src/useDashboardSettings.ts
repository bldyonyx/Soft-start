import type { WelcomeState } from "../../src/startupPolicy";
import { useEffect, useRef, useState } from "react";
import { customizationKeys, defaultSettings, type DashboardSettings, type SettingKey, type SettingsPatch } from "../../src/dashboardSettings";
import {
  isSettingsMessage, settingsHostMeta, settingsHostVersion, type SettingsMutation, type SettingsOutcome, type SettingsRequest,
} from "../../src/webviewMessages";

type Post = (request: SettingsRequest) => void;
type Operation = { requestId: string; mutation: SettingsMutation; draft: SettingsPatch };
type Feedback = Omit<Pick<SettingsOutcome, "outcome" | "detail" | "writes">, "outcome"> &
  { outcome: SettingsOutcome["outcome"] | "unknown" };

const replyTimeout = 8000;

export function useDashboardSettings(post: Post | undefined) {
  const [saved, setSaved] = useState(defaultSettings);
  const [draft, setDraft] = useState<SettingsPatch>({});
  const [welcome, setWelcome] = useState<WelcomeState>();
  const [welcomeGuidance, setWelcomeGuidance] = useState<string>();
  const [ready, setReady] = useState(false);
  const [hostBusy, setHostBusy] = useState(false);
  const [syncError, setSyncError] = useState<string>();
  const [rechecking, setRechecking] = useState(false);
  const [pending, setPending] = useState(false);
  const [unknown, setUnknown] = useState(false);
  const [feedback, setFeedback] = useState<Feedback>();
  const operation = useRef<Operation | undefined>(undefined);
  const mutationTimer = useRef<number | undefined>(undefined);
  const retryRead = useRef<(() => void) | undefined>(undefined);

  const hostSupportsSettings = Boolean(post && document.querySelector(`meta[name="${settingsHostMeta}"][content="${settingsHostVersion}"]`));

  useEffect(() => {
    if (!post || !hostSupportsSettings) {
      return;
    }
    let timer: number | undefined;
    let revision = 0;
    let authoritative = defaultSettings;
    let attempts = 0;
    let recovering = false;

    const requestSnapshot = () => {
      if (attempts === 3) {
        setRechecking(false);
        setSyncError("Could not load saved settings. Preview is available.");
        return;
      }
      attempts++;
      timer = window.setTimeout(requestSnapshot, 1500);
      post({ type: "requestSettings", recover: recovering ? operation.current?.requestId : undefined });
    };
    function stopReading() {
      window.clearTimeout(timer);
      setRechecking(false);
    }
    retryRead.current = () => {
      window.clearTimeout(timer);
      attempts = 0;
      recovering = true;
      setRechecking(true);
      setSyncError(undefined);
      requestSnapshot();
    };

    function settle(active: Operation, result: SettingsOutcome) {
      stopReading();
      window.clearTimeout(mutationTimer.current);
      operation.current = undefined;
      setPending(false);
      setUnknown(false);
      setFeedback(result);
      const snapshot = authoritative;
      setDraft((current) => reconcileDraft(current, active, result, snapshot));
    }

    const receive = ({ data }: MessageEvent<unknown>) => {
      if (!isSettingsMessage(data)) {
        return;
      }
      const active = operation.current;
      if (data.revision <= revision) {
        if (data.type === "settingsResult" && active?.requestId === data.requestId) {
          settle(active, data);
        }
        return;
      }
      revision = data.revision;
      if (data.type === "settingsLoadError") {
        stopReading();
        if (active) {
          window.clearTimeout(mutationTimer.current);
          setPending(false);
          setUnknown(true);
        }
        setReady(false);
        setSyncError(`Could not load saved settings. ${data.error}`);
        return;
      }
      setSyncError(undefined);
      authoritative = data.settings;
      setSaved(data.settings);
      setWelcome(data.welcome);
      setWelcomeGuidance(data.welcomeGuidance);
      setHostBusy(data.busy);
      setReady(true);

      if (data.type === "settingsResult" && active?.requestId === data.requestId) {
        settle(active, data);
      } else if (data.type === "settings" && active && data.recover === active.requestId && !data.busy) {
        stopReading();
        window.clearTimeout(mutationTimer.current);
        operation.current = undefined;
        setPending(false);
        setUnknown(false);
        setFeedback({ outcome: "unknown", detail: "Saved settings checked. The earlier action could not be confirmed. Review your remaining edits before retrying." });
        if (active.mutation.type === "saveSettings") {
          const changes = active.mutation.changes;
          setDraft((current) => reconcileDraft(current, active, {
            requestId: active.requestId, outcome: "success",
            writes: { applied: (Object.keys(changes) as SettingKey[]).filter((key) => changes[key] === data.settings[key]), rejected: {} },
          }, data.settings));
        }
      } else if (!recovering || (!active && !data.busy)) {
        stopReading();
      }
    };
    window.addEventListener("message", receive);
    requestSnapshot();
    return () => {
      window.clearTimeout(timer);
      window.clearTimeout(mutationTimer.current);
      retryRead.current = undefined;
      operation.current = undefined;
      window.removeEventListener("message", receive);
    };
  }, [post, hostSupportsSettings]);

  function edit<K extends SettingKey>(key: K, value: DashboardSettings[K]) {
    setDraft((current) => ({ ...current, [key]: value }));
  }

  function run(mutation: SettingsMutation) {
    if (!post || !ready || hostBusy || operation.current) {
      return;
    }
    const requestId = crypto.getRandomValues(new Uint32Array(4)).join("-");
    operation.current = { requestId, mutation, draft };
    setPending(true);
    setFeedback(undefined);
    mutationTimer.current = window.setTimeout(() => {
      setPending(false);
      setUnknown(true);
    }, replyTimeout);
    post({ ...mutation, requestId });
  }

  const keys = (Object.keys(draft) as SettingKey[]).filter((key) => saved[key] !== draft[key]);
  const changes = Object.fromEntries(keys.map((key) => [key, draft[key]]));
  const expected = Object.fromEntries(keys.map((key) => [key, saved[key]]));
  return {
    saved,
    welcome,
    welcomeGuidance,
    preview: { ...saved, ...draft },
    dirty: keys.length > 0,
    pending,
    unknown,
    rechecking,
    hostBusy,
    ready: ready && !unknown && !hostBusy,
    syncError: !post ? "Saved settings are available in VS Code." : !hostSupportsSettings
      ? "The dashboard and extension host use different settings versions. Restart the Extension Development Host and reopen the dashboard."
      : syncError,
    retry: hostSupportsSettings && (() => retryRead.current?.()),
    feedback,
    edit,
    save: () => {
      if (keys.length) {
        run({ type: "saveSettings", changes, expected });
      }
    },
    restore: () => run({ type: "restoreSettings" }),
    browse: () => run({ type: "browseProjectsDirectory" }),
    enableWelcome: () => run({ type: "enableWelcomeReplacement" }),
    restoreWelcome: () => run({ type: "restoreWelcomeReplacement" }),
  };
}

function reconcileDraft(
  current: SettingsPatch, operation: Operation, result: SettingsOutcome, saved: DashboardSettings,
): SettingsPatch {
  const next = { ...current };
  const { mutation, draft } = operation;
  for (const key of result.writes?.applied ?? []) {
    if (current[key] === draft[key] && (
      (mutation.type === "saveSettings" && mutation.changes[key] === saved[key]) ||
      (mutation.type === "restoreSettings" && customizationKeys.some((field) => field === key) && saved[key] === defaultSettings[key])
    )) {
      delete next[key];
    }
  }
  if (result.outcome === "success" &&
      (mutation.type === "enableWelcomeReplacement" || mutation.type === "restoreWelcomeReplacement") &&
      current.startupBehavior === draft.startupBehavior) {
    delete next.startupBehavior;
  }
  if (result.directory !== undefined && current.projectsDirectory === draft.projectsDirectory) {
    next.projectsDirectory = result.directory;
  }
  return next;
}
