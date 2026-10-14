# RoseClient 1.0.0 — Fabric-only client launcher

RoseClient is a Windows Electron launcher with separate Minecraft instance folders, Modrinth mod discovery/install, direct Fabric launching, and a client-side in-game HUD/menu mod.

## Supported loader
- **Fabric only.** Forge, NeoForge, and Quilt are not supported by RoseClient's in-game mod or instance creation flow.
- The bundled in-game RoseClient mod is built specifically for **Minecraft 26.1.2 + Fabric**. Do not install this JAR into other Minecraft versions or loaders.
- The launcher can create and launch other Minecraft versions when Fabric provides a compatible loader, and can install matching Fabric mods from Modrinth. The RoseClient in-game HUD mod itself will only be installed when the instance is Minecraft 26.1.2 + Fabric.

## Requirements
- Windows 10/11
- Node.js 20+ and npm (only needed to build the installer)
- Java 25 or newer for Minecraft 26.1.2 and compiling the in-game mod
- A Microsoft account that owns Minecraft: Java Edition
- Internet access for sign-in, Fabric setup, Modrinth, and first launch

## Build the Windows installer
1. Extract the entire project folder.
2. Run `BUILD-ROSECLIENT.bat`.
3. The script installs npm dependencies, compiles the Fabric 26.1.2 mod, copies the JAR into `resources/mods/`, and packages the Electron launcher.
4. Install the generated setup program from `release/`.

The first build needs internet access to download dependencies. A complete Windows installer build and first game launch still need to be tested on the target PC.

## First launch
1. Open RoseClient and create a Fabric instance.
2. Select it and click **Start Minecraft**.
3. RoseClient installs a compatible Fabric Loader for that Minecraft version when available.
4. Complete Microsoft sign-in. The account must own Minecraft: Java Edition.
5. RoseClient downloads the required game files and starts that instance with its own `mods` folder.

The first launch may take several minutes. A compatible Java runtime must be available. Java 25+ is required for Minecraft 26.1.2.

## Modrinth mods
The Modrinth browser filters mods by the selected instance's exact Minecraft version and Fabric loader. It downloads compatible mod versions into that instance's `mods` directory and installs required Modrinth dependencies when dependency metadata is available. The launcher records installations to show **Installed** and disable the Install button. Detection of manually copied mods is best-effort because filenames do not always match Modrinth project names.

## In-game mod
The bundled Fabric mod is client-side only; no server plugin is required for local HUD/menu modules. Press **Right Shift** in game to open the menu and click module cards to toggle them. This build targets Minecraft 26.1.2 + Fabric only. Other Minecraft versions may launch with Fabric, but the bundled RoseClient HUD mod is not injected into them unless a compatible RoseClient build is added later.

## Data locations
RoseClient stores its data under `%APPDATA%\RoseClient\`:
- `instances\<instance-id>\mods\` — instance mods
- `instances\<instance-id>\config\` — instance config
- `instances\<instance-id>\rose-instance.json` — instance metadata
- `settings.json` — launcher settings
- `cache\` — downloaded Fabric installer
- `login\` — reserved for non-secret metadata

Account tokens are not persisted by this build. Never save Microsoft passwords or access tokens as plain text.

## Security and limitations
Electron uses context isolation, `nodeIntegration: false`, a preload bridge, and IPC handlers. Microsoft sign-in is delegated to the MSMC library. Launcher, Microsoft OAuth, and a real first game launch need end-to-end testing on the target Windows machine. No single JAR is compatible with every Minecraft version; this package intentionally targets Fabric only.


## Java 25 detection troubleshooting
If RoseClient says Java 25 is missing even though `java -version` reports 25.x, close RoseClient completely and reopen it after checking environment variables. Set `JAVA_HOME` to the JDK installation directory (not its `bin` directory), for example `C:\Program Files\Java\jdk-25`, and ensure `%JAVA_HOME%\bin` is on `PATH`. The launcher now checks `JAVA_HOME`, Java executables found on PATH, and common Windows JDK install folders, and reports candidate versions in the error message.


## Installed mod inventory

Open **Modrinth Mods** and choose an instance to scan its local `mods` directory. RoseClient lists every `.jar` file it finds and attempts to read mod ID, name, version, description, authors, and loader metadata from common metadata files (`fabric.mod.json`, `quilt.mod.json`, Forge/NeoForge `mods.toml`, or legacy `mcmod.info`). If a JAR does not contain a recognized metadata file, it is still listed by filename and marked as unknown metadata. Use **Scan mods folder** to refresh after copying files manually.


## Launch status and Stop button

The launcher tracks the Java process created by `minecraft-launcher-core` and reports the instance state (`preparing`, `authenticating`, `starting`, `running`, `stopping`, `stopped`, or `failed`). The Overview and Instances pages poll this status while RoseClient is open. Use **Stop Minecraft** to cancel preparation/authentication or terminate the tracked Java process; on Windows, RoseClient also attempts to stop that process tree with `taskkill`. A launch is only reported as successful when a Java child process and PID were observed.

If the game fails to open, check the RoseClient console output for `[RoseClient/Minecraft]` messages and the displayed instance status. This implementation has been syntax-checked, but should still be tested on Windows with a real Microsoft-owned Minecraft: Java Edition account.

## In-game menu
Press Right Shift to open the HUD-drawn module panel. Opening the panel releases the mouse so you can click cards; closing it with Right Shift or the Close menu button recaptures the mouse. Modules are client-side visual and quality-of-life displays only. Added Player Name HUD, Sprint Status, Sneak Status, and Target Info.

## Additional client-side quality-of-life tools

- The in-game menu has a Tools tab with a **Quick GG** toggle. When enabled, press **F6** to send `gg` in chat; this is a manual shortcut, not an automatic match detector.
- Death Counter tracks deaths during the current session.
- World/target and held-item information can be enabled in the module menu.

No client feature can be guaranteed "unbannable": server rules differ, and some servers restrict macros or automated chat. Quick GG only sends when the player presses F6; keep it disabled if the server prohibits chat shortcuts. This remains client-side only.

## Importing Modrinth content

- **Import .mrpack** opens a file picker for a Modrinth `.mrpack` export. RoseClient reads `modrinth.index.json`, creates a new isolated Fabric instance, downloads indexed mod files, and applies files under `overrides/` with path traversal protection.
- **Import Modrinth instances** scans common local Modrinth App profile locations and imports readable Fabric profiles and their `mods`, `config`, `resourcepacks`, `shaderpacks`, and `options.txt` where available.
- RoseClient currently launches Fabric instances only. Non-Fabric packs are rejected rather than silently converted. Modrinth App profile storage varies by version; if a profile isn't detected, export it from Modrinth as `.mrpack` and use the first button.
