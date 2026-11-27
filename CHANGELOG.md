# Changelog

## Unreleased

Planned for **v0.1.0**.

### Dashboard and projects

- Open Soft Start from the Command Palette, the default keyboard shortcut, or an optional status bar button.
- Pin folders and saved workspaces. Rename pins, restore their original names, reorder them with drag or menu controls, locate unresolved entries, and unpin them.
- Keep up to 50 recent projects with a configurable dashboard limit and a picker for the full history.
- Create an empty project folder, open a folder, or start VS Code’s Git clone workflow from the dashboard.

### Appearance and settings

- Introduce Soft Start Signature typography, the Midnight Bunny tab icon, and the Midnight + Lavender default palette.
- Choose independent background and accent presets or custom hex colors. Adjust panel and artwork opacity, the welcome message, the header kaomoji, and decorative symbols.
- Preview changes live and save them explicitly. Restore Appearance and Dashboard defaults while keeping project data and startup settings.
- Choose a startup mode or opt to replace the native Welcome page. Restore the previous local preference, or follow manual restoration guidance in a remote window.

### Layout and accessibility

- Stack project lists in narrow editor splits and hide dashboard artwork at small widths.
- Support keyboard navigation, visible focus, menu-based pin reordering, reduced motion, and contrast-aware colors.
- Use subtler decorative borders on dark presets and bundled glyph fallbacks in the kaomoji input.

### Storage and recovery

- Keep history and pins in a host-scoped local journal on supported storage. Preserve explicitly addressed project locations and offer **Locate project** for unresolved legacy entries.
- Retain the legacy snapshot and support recovery of eligible pins from matching publisher-less journals.

### Known limitations

- Pins and recents require a native `file:` storage URI and atomic hard-link support. In the tested Linux desktop VS Code 1.148.0 host, `vscode-userdata:` storage disabled these lists. Quick Actions and Settings remain available subject to host capabilities.
- Soft Start collects its own history. It does not import VS Code’s **Open Recent** list or synchronize project data between independent stores.
- Remote startup restoration requires checking the original User and Remote settings layers manually.
