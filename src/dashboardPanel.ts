type Panel = { reveal(): void };

export class DashboardPanel<T extends Panel> {
  private panel: T | undefined;
  private startupAttempted = false;

  constructor(private readonly create: (preserveFocus: boolean) => T) {}

  open(): void {
    this.startupAttempted = true;
    if (this.panel) {
      this.panel.reveal();
    } else {
      this.panel = this.create(false);
    }
  }

  openAtStartup(shouldOpen: () => boolean, preserveFocus: boolean): void {
    if (this.startupAttempted) {
      return;
    }
    this.startupAttempted = true;
    if (!this.panel && shouldOpen()) {
      this.panel = this.create(preserveFocus);
    }
  }

  closed(panel: T): void {
    if (this.panel === panel) {
      this.panel = undefined;
    }
  }
}
