import { join } from "node:path";
import { app, BrowserWindow, dialog, Menu, type MenuItemConstructorOptions, safeStorage, session, shell } from "electron";
import { appDataDir, loadConfig, readMasterKey, type RunningGateway, startGateway } from "@costgrid/gateway";
import { loadMasterKey } from "./master-key.js";

/**
 * CostGrid as an app: the gateway running inside this process, and its
 * console in a window.
 *
 * The window shows ordinary web pages served by the gateway on this machine.
 * It has no access to Node, no preload and no bridge: everything the page can
 * do, it does through the same HTTP routes a browser would use, and the
 * gateway's own security policy applies to it. What the shell adds is a
 * place to keep the master key (the operating system's secure storage) and a
 * double-click way to start.
 */

const DATA_DIR = join(appDataDir(), "CostGrid");
const KEY_FILE = join(DATA_DIR, "master-key.enc");

let gateway: RunningGateway | undefined;
let origin = "";

// Opened from the Finder or the Dock, the app has no terminal, and a write to
// stdout or stderr can fail (Node sends its warnings there). Without a
// listener that failure is an uncaught exception, which Electron shows as a
// crash dialog. With one, the message is simply lost, which is fine.
for (const stream of [process.stdout, process.stderr]) stream.on("error", () => {});

// Everything the app writes lives with the gateway's database, so a person
// looking for "where CostGrid keeps my data" finds one folder.
app.setName("CostGrid");
app.setPath("userData", DATA_DIR);

// Automated tests run on Linux with no keyring. This makes safeStorage use a
// fixed key instead, which protects nothing, so it has to be asked for by name
// and is refused below in every other case.
const allowBasicStorage =
  process.platform === "linux" && process.env["COSTGRID_ALLOW_BASIC_STORAGE"] === "1";
if (allowBasicStorage) safeStorage.setUsePlainTextEncryption(true);

// One copy at a time. Two gateways on the same database would fight over the
// port and the file.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    const [win] = BrowserWindow.getAllWindows();
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    } else if (origin !== "") {
      createWindow();
    }
  });
  app.whenReady().then(boot, fail);
}

async function boot(): Promise<void> {
  try {
    hardenSession();
    Menu.setApplicationMenu(applicationMenu());

    if (
      process.platform === "linux" &&
      safeStorage.getSelectedStorageBackend() === "basic_text" &&
      !allowBasicStorage
    ) {
      // basic_text is safeStorage without the safe: the key would sit on disk
      // obscured rather than encrypted. Refused unless a test asks for it.
      throw new Error(
        "This computer has no keyring to protect the key that encrypts your provider " +
          "credentials, so CostGrid cannot start.",
      );
    }

    const master = loadMasterKey({
      file: KEY_FILE,
      store: safeStorage,
      // A Mac may already hold the key from `npm run desktop`; adopt it rather
      // than strand the credentials encrypted under it.
      existing: process.platform === "darwin" ? () => readMasterKey() : undefined,
    });

    // The gateway's own configuration, with the desktop defaults filled in.
    // Anything already in the environment wins, so a port or log level can
    // still be set by whoever launches the app.
    const defaults: Record<string, string> = {
      COSTGRID_DESKTOP: "true",
      COSTGRID_MASTER_KEY_SOURCE: "keychain",
      COSTGRID_LOG_FILE: join(DATA_DIR, "costgrid.log"),
    };
    for (const [name, value] of Object.entries(defaults)) process.env[name] ??= value;

    gateway = await startGateway(loadConfig({ readKeychain: () => master.key }));
    origin = gateway.url;
    createWindow();
  } catch (error) {
    fail(error);
  }
}

function fail(error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  const inUse = /EADDRINUSE/.test(message);
  // To the terminal as well, for whoever launched it from one.
  console.error(`CostGrid could not start: ${message}`);
  dialog.showErrorBox(
    "CostGrid could not start",
    inUse
      ? "Something on this computer is already using port 8787, most likely another copy of " +
          "CostGrid. Quit it and open CostGrid again."
      : message,
  );
  process.exitCode = 1;
  app.quit();
  // Should the orderly quit stall, do not leave a dead process behind.
  setTimeout(() => process.exit(1), 3000).unref();
}

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1240,
    height: 860,
    minWidth: 900,
    minHeight: 600,
    title: "CostGrid",
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webviewTag: false,
      navigateOnDragDrop: false,
      spellcheck: false,
    },
  });
  win.once("ready-to-show", () => win.show());

  // The window shows this gateway and nothing else. A link to anywhere else
  // opens in the person's browser, where it belongs.
  win.webContents.setWindowOpenHandler(({ url }) => {
    openOutside(url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (event, url) => {
    if (!url.startsWith(`${origin}/`)) {
      event.preventDefault();
      openOutside(url);
    }
  });

  void win.loadURL(`${origin}/console`);
  return win;
}

function openOutside(url: string): void {
  if (url.startsWith("https://")) void shell.openExternal(url);
}

/** Show a page of this gateway in the front window, opening one if needed. */
function go(path: string): void {
  if (origin === "") return;
  const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0] ?? createWindow();
  void win.loadURL(`${origin}${path}`);
}

function hardenSession(): void {
  // No page here needs the camera, location, notifications or anything else
  // a page can ask for.
  session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => {
    callback(false);
  });
  app.on("web-contents-created", (_event, contents) => {
    contents.on("will-attach-webview", (event) => event.preventDefault());
  });
}

/** The usual menus, minus developer tools. Copy and paste need the Edit roles on a Mac. */
function applicationMenu(): Menu {
  const mac = process.platform === "darwin";
  const template: MenuItemConstructorOptions[] = [
    ...(mac ? [{ role: "appMenu" as const }] : []),
    { role: "editMenu" },
    {
      label: "View",
      submenu: [
        { label: "Console", accelerator: "CmdOrCtrl+1", click: () => go("/console") },
        { label: "Dashboard", accelerator: "CmdOrCtrl+2", click: () => go("/") },
        { type: "separator" },
        {
          label: "Back",
          accelerator: "CmdOrCtrl+[",
          click: () => BrowserWindow.getFocusedWindow()?.webContents.navigationHistory.goBack(),
        },
        {
          label: "Forward",
          accelerator: "CmdOrCtrl+]",
          click: () => BrowserWindow.getFocusedWindow()?.webContents.navigationHistory.goForward(),
        },
        { type: "separator" },
        { role: "reload" },
        { type: "separator" },
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        { type: "separator" },
        { role: "togglefullscreen" },
      ],
    },
    { role: "windowMenu" },
    {
      role: "help",
      submenu: [
        {
          label: "Open in your browser",
          click: () => void shell.openExternal(`${origin}/console`),
        },
        {
          label: "Show data folder",
          click: () => void shell.openPath(DATA_DIR),
        },
      ],
    },
  ];
  return Menu.buildFromTemplate(template);
}

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0 && origin !== "") createWindow();
});

// On a Mac the app stays in the dock with the window closed, and the gateway
// keeps metering. Elsewhere, closing the window is quitting.
app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

// Stop the gateway cleanly, once, before the process goes.
app.on("before-quit", (event) => {
  if (gateway === undefined) return;
  event.preventDefault();
  const running = gateway;
  gateway = undefined;
  void running.close().finally(() => app.quit());
});
