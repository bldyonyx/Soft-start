import { defaultSettings, type DashboardSettings } from "../../src/dashboardSettings";

type RGB = [number, number, number];
const rgb = (color: string): RGB => [
  Number.parseInt(color.slice(1, 3), 16),
  Number.parseInt(color.slice(3, 5), 16),
  Number.parseInt(color.slice(5, 7), 16),
];

function luminance(color: RGB): number {
  const [r, g, b] = color.map((channel) => {
    const value = channel / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return r * 0.2126 + g * 0.7152 + b * 0.0722;
}

function mix(from: RGB, to: RGB, amount: number): RGB {
  return [
    Math.round(from[0] + (to[0] - from[0]) * amount),
    Math.round(from[1] + (to[1] - from[1]) * amount),
    Math.round(from[2] + (to[2] - from[2]) * amount),
  ];
}

function css(color: RGB) {
  return `rgb(${color.join(" ")})`;
}

function readable(preferred: RGB, foreground: RGB, surfaces: RGB[]): string {
  for (let step = 0; step < 20; step++) {
    const shade = mix(preferred, foreground, step / 20);
    const light = luminance(shade) + 0.05;
    if (surfaces.every((surface) => {
      const base = luminance(surface) + 0.05;
      return Math.max(light, base) / Math.min(light, base) >= 4.5;
    })) {
      return css(shade);
    }
  }
  return css(foreground);
}

function themeColors(background: string, accent: string): Record<string, string> {
  const base = rgb(background);
  if (background === defaultSettings.backgroundColor) {
    if (accent === defaultSettings.accentColor) {
      return {};
    }
    return { "--lavender": readable(rgb(accent), rgb("#ffffff"), [
      base, rgb("#0f0e11"), rgb("#151318"), rgb("#19171d"), rgb("#211d27"),
    ]) };
  }

  const light = luminance(base) >= 0.179;
  const foreground = rgb(light ? "#000000" : "#ffffff");
  const tint = light ? rgb("#ffffff") : rgb("#211d27");
  const surface = mix(base, tint, 0.24);
  const title = mix(base, tint, 0.52);
  const elevated = mix(base, tint, 0.68);
  const hover = mix(base, tint, 0.86);
  const surfaces = [base, surface, title, elevated, hover];

  return {
    "--surface": css(surface),
    "--title-bar": css(title),
    "--elevated": css(elevated),
    "--hover-surface": css(hover),
    "--text": css(foreground),
    "--secondary": readable(mix(foreground, base, 0.22), foreground, surfaces),
    "--muted": readable(mix(foreground, base, 0.36), foreground, surfaces),
    "--lavender": readable(rgb(accent), foreground, surfaces),
    "--blue": readable(rgb("#a0d8f2"), foreground, surfaces),
    "--border": css(mix(base, foreground, 0.55)),
    "color-scheme": light ? "light" : "dark",
  };
}

function artworkFilter(background: string): string {
  const base = luminance(rgb(background));
  if (base >= 0.179) {
    return "brightness(0)";
  }
  // These are the original SVG stroke and its contrast against the selected background.
  const stroke = luminance(rgb("#a8a3ad"));
  return (stroke + 0.05) / (base + 0.05) >= 4.5 ? "none" : "brightness(0) invert(1)";
}

export function applyDashboardTheme(settings: Pick<DashboardSettings, "backgroundColor" | "accentColor" | "panelOpacity" | "artworkVisible" | "artworkOpacity">): () => void {
  const { style } = document.documentElement;
  const background = settings.backgroundColor.toLowerCase();
  const opacity = settings.artworkVisible ? settings.artworkOpacity : 0;
  const tokens = {
    ...themeColors(background, settings.accentColor.toLowerCase()),
    "--background": settings.backgroundColor,
    "--panel-opacity": `${settings.panelOpacity}%`,
    "--artwork-opacity": String(opacity / 100),
    "--artwork-filter": artworkFilter(background),
  };
  // Individual CSSOM declarations work with the webview's existing style CSP.
  for (const [property, value] of Object.entries(tokens)) {
    style.setProperty(property, value);
  }
  return () => Object.keys(tokens).forEach((property) => style.removeProperty(property));
}
