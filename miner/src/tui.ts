import blessed from "blessed";
import contrib from "blessed-contrib";

/**
 * Data model for TUI dashboard state
 */
export interface DashboardState {
  // Mining status
  challengeNumber: string;
  difficulty: string;
  seed: string;
  status: string;
  reward: string;

  // Performance
  hashRate: number;
  noncesTried: number;

  // Rewards
  totalMined: string;
  blocksMined: number;
  bnbBalance: string;
  nextHalving: string;

  // AI Agent
  aiModel: string;
  aiCalls: number;
  aiTokens: number;
  aiLastText: string;

  // Network
  networkSolutions: number;
  networkTotalMined: string;
  minerAddress: string;
  workers: number;
}

/**
 * Terminal User Interface (TUI) dashboard.
 * Renders a btop/htop-style dashboard with mining stats, hash rate chart,
 * scrolling hash log, and AI agent status.
 */
export class Dashboard {
  private screen: blessed.Widgets.Screen;
  private grid: any;

  // Widgets
  private statusBox!: blessed.Widgets.BoxElement;
  private rewardsBox!: blessed.Widgets.BoxElement;
  private aiBox!: blessed.Widgets.BoxElement;
  private hashRateChart!: any;
  private hashLog!: any;

  // State
  private state: DashboardState;
  private hashRateData: number[] = [];
  private logLines: string[] = [];

  constructor() {
    this.state = this._defaultState();

    // Create the screen
    this.screen = blessed.screen({
      smartCSR: true,
      title: "AI Mine - Proof of AI Work Mining Client",
      fullUnicode: true,
    });

    // Create grid layout (12x12)
    this.grid = new contrib.grid({
      rows: 12,
      cols: 12,
      screen: this.screen,
    });

    this._initWidgets();
    this._bindKeys();
  }

  /**
   * Display ASCII art splash screen before starting dashboard
   */
  static showSplash(): string {
    return [
      "",
      "  \x1b[36m╔══════════════════════════════════════════════╗\x1b[0m",
      "  \x1b[36m║\x1b[0m      \x1b[1;33m_    ___   __  __ _\x1b[0m                    \x1b[36m║\x1b[0m",
      "  \x1b[36m║\x1b[0m     \x1b[1;33m/ \\  |_ _| |  \\/  (_)_ __   ___\x1b[0m         \x1b[36m║\x1b[0m",
      "  \x1b[36m║\x1b[0m    \x1b[1;33m/ _ \\  | |  | |\\/| | | '_ \\ / _ \\\x1b[0m        \x1b[36m║\x1b[0m",
      "  \x1b[36m║\x1b[0m   \x1b[1;33m/ ___ \\ | |  | |  | | | | | |  __/\x1b[0m        \x1b[36m║\x1b[0m",
      "  \x1b[36m║\x1b[0m  \x1b[1;33m/_/   \\_\\___| |_|  |_|_|_| |_|\\___|\x1b[0m        \x1b[36m║\x1b[0m",
      "  \x1b[36m║\x1b[0m                                              \x1b[36m║\x1b[0m",
      "  \x1b[36m║\x1b[0m   \x1b[1;37mProof of AI Work Mining Client v1.0\x1b[0m        \x1b[36m║\x1b[0m",
      "  \x1b[36m║\x1b[0m   \x1b[90mPowered by AI + Blockchain\x1b[0m                 \x1b[36m║\x1b[0m",
      "  \x1b[36m╚══════════════════════════════════════════════╝\x1b[0m",
      "",
    ].join("\n");
  }

  /**
   * Initialize all dashboard widgets
   */
  private _initWidgets(): void {
    // --- Mining Status (top-left, 4 rows x 5 cols) ---
    this.statusBox = this.grid.set(0, 0, 4, 5, blessed.box, {
      label: " {bold}Mining Status{/bold} ",
      tags: true,
      border: { type: "line" },
      style: {
        border: { fg: "cyan" },
        label: { fg: "cyan" },
      },
      padding: { left: 1, right: 1 },
    });

    // --- Rewards (middle-left, 4 rows x 5 cols) ---
    this.rewardsBox = this.grid.set(4, 0, 4, 5, blessed.box, {
      label: " {bold}Rewards{/bold} ",
      tags: true,
      border: { type: "line" },
      style: {
        border: { fg: "green" },
        label: { fg: "green" },
      },
      padding: { left: 1, right: 1 },
    });

    // --- AI Agent (bottom-left, 4 rows x 5 cols) ---
    this.aiBox = this.grid.set(8, 0, 4, 5, blessed.box, {
      label: " {bold}AI Agent{/bold} ",
      tags: true,
      border: { type: "line" },
      style: {
        border: { fg: "magenta" },
        label: { fg: "magenta" },
      },
      padding: { left: 1, right: 1 },
    });

    // --- Hash Rate Chart (top-right, 6 rows x 7 cols) ---
    this.hashRateChart = this.grid.set(0, 5, 6, 7, contrib.line, {
      label: " {bold}Hash Rate (KH/s){/bold} ",
      tags: true,
      style: {
        line: "yellow",
        text: "white",
        border: { fg: "yellow" },
        label: { fg: "yellow" },
      },
      xLabelPadding: 3,
      xPadding: 5,
      showLegend: false,
      wholeNumbersOnly: true,
    });

    // --- Hash Log (bottom-right, 6 rows x 7 cols) ---
    this.hashLog = this.grid.set(6, 5, 6, 7, contrib.log, {
      label: " {bold}Hash Log{/bold} ",
      tags: true,
      border: { type: "line" },
      style: {
        border: { fg: "white" },
        label: { fg: "white" },
      },
      bufferLength: 100,
    });
  }

  /**
   * Bind keyboard shortcuts
   */
  private _bindKeys(): void {
    this.screen.key(["escape", "q", "C-c"], () => {
      this.destroy();
      process.exit(0);
    });
  }

  /**
   * Update dashboard state and re-render
   */
  update(partial: Partial<DashboardState>): void {
    Object.assign(this.state, partial);
    this._render();
  }

  /**
   * Add a hash log entry
   */
  logHash(hash: string, valid: boolean): void {
    const prefix = hash.slice(0, 10) + "..." + hash.slice(-6);
    const mark = valid
      ? "{bold}{green-fg}\u2713 FOUND!{/green-fg}{/bold}"
      : "{red-fg}\u2717{/red-fg}";
    this.hashLog.log(`${prefix} ${mark}`);
  }

  /**
   * Add a general log message
   */
  log(message: string): void {
    this.hashLog.log(message);
  }

  /**
   * Render all widgets with current state
   */
  private _render(): void {
    const s = this.state;

    // --- Mining Status ---
    this.statusBox.setContent(
      `{bold}Challenge:{/bold}  {yellow-fg}#${s.challengeNumber}{/yellow-fg}\n` +
      `{bold}Difficulty:{/bold} ${s.difficulty}\n` +
      `{bold}Status:{/bold}    ${s.status}\n` +
      `{bold}Workers:{/bold}   {cyan-fg}${s.workers} threads{/cyan-fg}\n` +
      `{bold}Nonces:{/bold}    ${this._formatNumber(s.noncesTried)} tried`
    );

    // --- Rewards ---
    this.rewardsBox.setContent(
      `{bold}My Balance:{/bold}    {green-fg}${s.totalMined} AIT{/green-fg}\n` +
      `{bold}My Blocks:{/bold}     {green-fg}${s.blocksMined}{/green-fg}\n` +
      `{bold}Network Total:{/bold} {yellow-fg}${s.networkSolutions} blocks / ${s.networkTotalMined} AIT{/yellow-fg}\n` +
      `{bold}Block Reward:{/bold}  ${s.reward} AIT\n` +
      `{bold}Next Halving:{/bold}  ${s.nextHalving}\n` +
      `{bold}BNB Balance:{/bold}   ${s.bnbBalance} BNB`
    );

    // --- AI Agent ---
    this.aiBox.setContent(
      `{bold}Model:{/bold}       {magenta-fg}${s.aiModel}{/magenta-fg}\n` +
      `{bold}API Calls:{/bold}   ${s.aiCalls}\n` +
      `{bold}Tokens Used:{/bold} ${this._formatNumber(s.aiTokens)}\n` +
      `{bold}Last Text:{/bold}   {90-fg}${s.aiLastText.slice(0, 40)}{/90-fg}\n` +
      `{bold}Address:{/bold}     {90-fg}${s.minerAddress.slice(0, 10)}...{/90-fg}`
    );

    // --- Hash Rate Chart ---
    this.hashRateData.push(s.hashRate / 1000); // Convert to KH/s
    if (this.hashRateData.length > 60) this.hashRateData.shift();

    const labels = this.hashRateData.map((_, i) => String(i));
    this.hashRateChart.setData([
      {
        title: "KH/s",
        x: labels,
        y: this.hashRateData,
      },
    ]);

    this.screen.render();
  }

  /**
   * Format large numbers with comma separators
   */
  private _formatNumber(n: number): string {
    return n.toLocaleString("en-US");
  }

  /**
   * Get default empty state
   */
  private _defaultState(): DashboardState {
    return {
      challengeNumber: "0",
      difficulty: "0",
      seed: "",
      status: "{yellow-fg}Initializing...{/yellow-fg}",
      reward: "0",
      hashRate: 0,
      noncesTried: 0,
      totalMined: "0",
      blocksMined: 0,
      bnbBalance: "0",
      nextHalving: "-",
      aiModel: "-",
      aiCalls: 0,
      aiTokens: 0,
      aiLastText: "-",
      networkSolutions: 0,
      networkTotalMined: "0",
      minerAddress: "",
      workers: 0,
    };
  }

  /**
   * Clean up and destroy the screen
   */
  destroy(): void {
    this.screen.destroy();
  }
}
