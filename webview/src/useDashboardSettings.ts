import { useEffect, useRef, useState } from "react";
import { defaultSettings, type DashboardSettings, type SettingKey, type SettingsPatch } from "../../src/dashboardSettings";
import { isSettingsMessage, settingsHostMeta, type SettingsRequest } from "../../src/webviewMessages";

type Post = (request: SettingsRequest) => void;

export function useDashboardSettings(post: Post | undefined) {
  const [saved, setSaved] = useState(defaultSettings);
  const [draft, setDraft] = useState<SettingsPatch>({});
  const [ready, setReady] = useState(false);
  const [syncError, setSyncError] = useState<string>();
  const [syncAttempt, setSyncAttempt] = useState(0);
  const [pending, setPending] = useState(false);
  const operation = useRef<SettingsRequest["type"] | undefined>(undefined);
  const [feedback, setFeedback] = useState<{ text: string; error?: boolean }>();

  const hostSupportsSettings = Boolean(post && document.querySelector(`meta[name="${settingsHostMeta}"][content="1"]`));

  useEffect(() => {
    if (!post || !hostSupportsSettings) {
      return;
    }
    let timer: number | undefined;
    let requests = 0;
    const requestSnapshot = () => {
      if (requests === 3) {
        setSyncError("Could not load saved settings. Preview is available.");
        return;
      }
      requests++;
      post({ type: "requestSettings" });
      timer = window.setTimeout(requestSnapshot, 1500);
    };
    const receive = ({ data }: MessageEvent<unknown>) => {
      if (!isSettingsMessage(data)) {
        return;
      }
      window.clearTimeout(timer);
      if (data.type === "settingsLoadError") {
        operation.current = undefined;
        setPending(false);
        setReady(false);
        setFeedback(undefined);
        setSyncError(`Could not load saved settings. ${data.error}`);
        return;
      }
      setSyncError(undefined);
      setSaved(data.settings);
      setReady(true);
      if (data.type === "settingsResult") {
        const completed = operation.current;
        operation.current = undefined;
        setPending(false);
        if (completed === "saveSettings" || (completed === "restoreSettings" && (data.status || data.error))) {
          setDraft(completed === "restoreSettings" ? (current) => (
            current.projectsDirectory === undefined ? {} : { projectsDirectory: current.projectsDirectory }
          ) : {});
        }
        if (data.directory !== undefined) {
          setDraft((current) => ({ ...current, projectsDirectory: data.directory }));
        }
        setFeedback(data.error ? { text: data.error, error: true } :
          data.status ? { text: data.status } : undefined);
      }
    };
    window.addEventListener("message", receive);
    requestSnapshot();
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener("message", receive);
    };
  }, [post, hostSupportsSettings, syncAttempt]);

  function edit<K extends SettingKey>(key: K, value: DashboardSettings[K]) {
    setDraft((current) => {
      return { ...current, [key]: value };
    });
    setFeedback(undefined);
  }

  function run(request: SettingsRequest) {
    if (post && ready && !operation.current) {
      operation.current = request.type;
      setPending(true);
      setFeedback(undefined);
      post(request);
    }
  }

  const changes = Object.fromEntries(Object.entries(draft).filter(([key, value]) => saved[key as SettingKey] !== value));

  return {
    saved,
    preview: { ...saved, ...draft },
    dirty: Object.keys(changes).length > 0,
    pending,
    ready,
    syncError: !post ? "Saved settings are available in VS Code." : !hostSupportsSettings
      ? "This extension host is running an older Soft Start build. Restart the Extension Development Host and reopen the dashboard."
      : syncError,
    retry: hostSupportsSettings && (() => {
      setSyncError(undefined);
      setSyncAttempt((attempt) => attempt + 1);
    }),
    feedback,
    edit,
    save: () => run({ type: "saveSettings", changes }),
    restore: () => run({ type: "restoreSettings" }),
    browse: () => run({ type: "browseProjectsDirectory" }),
  };
}
