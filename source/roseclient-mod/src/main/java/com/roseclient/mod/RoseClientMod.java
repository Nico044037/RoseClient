package com.roseclient.mod;

import com.mojang.blaze3d.platform.InputConstants;
import net.fabricmc.api.ClientModInitializer;
import net.fabricmc.fabric.api.client.event.lifecycle.v1.ClientTickEvents;
import net.fabricmc.fabric.api.client.keymapping.v1.KeyMappingHelper;
import net.fabricmc.fabric.api.client.rendering.v1.hud.HudElementRegistry;
import net.minecraft.client.KeyMapping;
import net.minecraft.client.Minecraft;
import net.minecraft.client.gui.GuiGraphicsExtractor;
import net.minecraft.resources.Identifier;
import org.lwjgl.glfw.GLFW;

import java.time.LocalTime;
import java.time.format.DateTimeFormatter;
import java.util.ArrayDeque;
import java.util.LinkedHashMap;
import java.util.Map;

/** RoseClient's lightweight, client-side visual HUD and clickable module panel. */
public final class RoseClientMod implements ClientModInitializer {
    private static final Identifier HUD_ID = Identifier.fromNamespaceAndPath("roseclient", "hud");
    private static final int PINK = 0xFFFF8FC7;
    private static final int WHITE = 0xFFF5EDF3;
    private static final int MUTED = 0xFFBBA9B8;
    private static final int PANEL = 0xF018121D;
    private static final int CARD = 0xF5281D2B;
    private static final DateTimeFormatter CLOCK = DateTimeFormatter.ofPattern("HH:mm:ss");

    private static boolean menuOpen;
    private static KeyMapping menuKey;
    private static KeyMapping quickGgKey;
    private static int deathCount;
    private static float previousHealth = -1.0f;
    private static boolean wasLeftDown;
    private static int activeCategory;
    private static int clickCount;
    private static long lastClickAt;
    private static long sessionStartedAt = System.currentTimeMillis();
    private static final ArrayDeque<Long> recentClicks = new ArrayDeque<>();
    private static final Map<String, Boolean> MODULES = new LinkedHashMap<>();

    static {
        // HUD and quality-of-life modules only. No combat automation or gameplay advantages.
        MODULES.put("FPS Counter", true);
        MODULES.put("Coordinates", true);
        MODULES.put("Direction", false);
        MODULES.put("Clock", false);
        MODULES.put("Session Timer", false);
        MODULES.put("CPS Counter", false);
        MODULES.put("Keystrokes HUD", false);
        MODULES.put("Module List", false);
        MODULES.put("Crosshair Dot", false);
        MODULES.put("Compact HUD", false);
        MODULES.put("Pink Accent", true);
        MODULES.put("Welcome Badge", true);
        MODULES.put("Memory Monitor", false);
        MODULES.put("Item Count HUD", false);
        MODULES.put("Cosmetic Nametag", false);
        MODULES.put("Health HUD", false);
        MODULES.put("Hunger HUD", false);
        MODULES.put("XP Level HUD", false);
        MODULES.put("Held Item Name", false);
        MODULES.put("Velocity HUD", false);
        MODULES.put("Player Name HUD", false);
        MODULES.put("Sprint Status", false);
        MODULES.put("Sneak Status", false);
        MODULES.put("Target Info", false);
        MODULES.put("Quick GG", true);
        MODULES.put("Death Counter", false);
        MODULES.put("World Name", false);
        MODULES.put("Dimension Info", false);
        MODULES.put("Block Target Info", false);
        MODULES.put("Entity Target Name", false);
        MODULES.put("Held Item Durability", false);
        MODULES.put("Food Saturation Hint", false);
    }

    @Override
    public void onInitializeClient() {
        KeyMapping.Category category = KeyMapping.Category.register(
            Identifier.fromNamespaceAndPath("roseclient", "main")
        );
        menuKey = KeyMappingHelper.registerKeyMapping(new KeyMapping(
            "key.roseclient.open_menu", InputConstants.Type.KEYSYM, GLFW.GLFW_KEY_RIGHT_SHIFT, category
        ));
        quickGgKey = KeyMappingHelper.registerKeyMapping(new KeyMapping(
            "key.roseclient.quick_gg", InputConstants.Type.KEYSYM, GLFW.GLFW_KEY_F6, category
        ));
        ClientTickEvents.END_CLIENT_TICK.register(client -> {
            while (menuKey.consumeClick()) {
                menuOpen = !menuOpen;
                // This is a HUD-drawn menu rather than a Screen, so explicitly release
                // the cursor when opening it and recapture it when closing it.
                if (menuOpen) {
                    client.mouseHandler.releaseMouse();
                } else if (client.player != null && client.getWindow() != null) {
                    client.mouseHandler.grabMouse();
                }
            }
            while (quickGgKey.consumeClick()) {
                if (enabled("Quick GG") && client.player != null && client.getConnection() != null) {
                    client.player.connection.sendChat("gg");
                }
            }
            if (client.player == null || client.getWindow() == null) return;
            float healthNow = client.player.getHealth();
            if (previousHealth > 0.0f && healthNow <= 0.0f) deathCount++;
            previousHealth = healthNow;

            boolean leftDown = GLFW.glfwGetMouseButton(client.getWindow().handle(), GLFW.GLFW_MOUSE_BUTTON_1) == GLFW.GLFW_PRESS;
            if (leftDown && !wasLeftDown) {
                double[] x = new double[1], y = new double[1];
                GLFW.glfwGetCursorPos(client.getWindow().handle(), x, y);
                double sx = x[0] * client.getWindow().getGuiScaledWidth() / client.getWindow().getWidth();
                double sy = y[0] * client.getWindow().getGuiScaledHeight() / client.getWindow().getHeight();
                registerClick();
                if (menuOpen) handleMenuClick((int) sx, (int) sy, client);
            }
            wasLeftDown = leftDown;
            if (menuOpen) {
                // Avoid accidental attacks/interactions while clicking the HUD panel.
                client.options.keyAttack.setDown(false);
                client.options.keyUse.setDown(false);
            }
        });
        HudElementRegistry.addLast(HUD_ID, RoseClientMod::renderHud);
    }

    private static void registerClick() {
        long now = System.currentTimeMillis();
        recentClicks.addLast(now);
        while (!recentClicks.isEmpty() && now - recentClicks.peekFirst() > 1000) recentClicks.removeFirst();
        clickCount = recentClicks.size();
        lastClickAt = now;
    }

    private static void handleMenuClick(int x, int y, Minecraft client) {
        int left = Math.max(12, (client.getWindow().getGuiScaledWidth() - 500) / 2);
        int top = Math.max(12, (client.getWindow().getGuiScaledHeight() - 326) / 2);
        if (x < left || x > left + 500 || y < top || y > top + 326) return;
        // Category tabs
        for (int i = 0; i < 4; i++) {
            int tx = left + 16 + i * 116;
            if (inside(x, y, tx, top + 42, tx + 108, top + 68)) { activeCategory = i; return; }
        }
        String[] names = MODULES.keySet().toArray(new String[0]);
        int index = 0;
        for (String name : names) {
            int category = index / 8;
            int within = index % 8;
            index++;
            if (category != activeCategory) continue;
            int col = within / 4;
            int row = within % 4;
            int bx = left + 16 + col * 236;
            int by = top + 82 + row * 43;
            if (inside(x, y, bx, by, bx + 222, by + 34)) {
                MODULES.put(name, !MODULES.get(name));
                return;
            }
        }
        if (inside(x, y, left + 16, top + 270, left + 238, top + 302)) {
            // One-click visual preset.
            MODULES.put("FPS Counter", true);
            MODULES.put("Coordinates", true);
            MODULES.put("Welcome Badge", true);
            MODULES.put("Pink Accent", true);
            MODULES.put("Direction", false);
            MODULES.put("Clock", false);
        } else if (inside(x, y, left + 262, top + 270, left + 484, top + 302)) {
            menuOpen = false;
            client.mouseHandler.grabMouse();
        }
    }

    private static boolean inside(int x, int y, int x1, int y1, int x2, int y2) {
        return x >= x1 && x <= x2 && y >= y1 && y <= y2;
    }

    private static boolean enabled(String name) { return MODULES.getOrDefault(name, false); }

    private static void renderHud(GuiGraphicsExtractor g, net.minecraft.client.DeltaTracker delta) {
        Minecraft mc = Minecraft.getInstance();
        if (mc.player == null || mc.options.hideGui) return;
        int width = mc.getWindow().getGuiScaledWidth();
        int height = mc.getWindow().getGuiScaledHeight();
        int accent = enabled("Pink Accent") ? PINK : 0xFF8FBFFF;
        boolean compact = enabled("Compact HUD");
        int line = compact ? 10 : 12;
        int y = 8;

        if (enabled("Welcome Badge")) {
            g.fill(8, 7, 106, 24, 0xB51A111C);
            g.fill(8, 7, 10, 24, accent);
            g.text(mc.font, "RoseClient", 15, 11, accent, true);
            y = 30;
        }
        if (enabled("FPS Counter")) { textLine(g, mc, "FPS: " + mc.getFps(), 8, y, accent); y += line; }
        if (enabled("Coordinates")) {
            textLine(g, mc, String.format("XYZ: %d  %d  %d", mc.player.getBlockX(), mc.player.getBlockY(), mc.player.getBlockZ()), 8, y, WHITE);
            y += line;
        }
        if (enabled("Direction")) { textLine(g, mc, "Facing: " + mc.player.getDirection().getName().toUpperCase(), 8, y, WHITE); y += line; }
        if (enabled("Clock")) { textLine(g, mc, LocalTime.now().format(CLOCK), 8, y, WHITE); y += line; }
        if (enabled("Session Timer")) {
            long seconds = (System.currentTimeMillis() - sessionStartedAt) / 1000;
            textLine(g, mc, String.format("Session: %02d:%02d:%02d", seconds / 3600, (seconds / 60) % 60, seconds % 60), 8, y, WHITE); y += line;
        }
        if (enabled("CPS Counter")) { textLine(g, mc, "CPS: " + clickCount, 8, y, WHITE); y += line; }
        if (enabled("Memory Monitor")) {
            Runtime rt = Runtime.getRuntime();
            long used = (rt.totalMemory() - rt.freeMemory()) / (1024 * 1024);
            long max = rt.maxMemory() / (1024 * 1024);
            textLine(g, mc, "Memory: " + used + " / " + max + " MB", 8, y, WHITE); y += line;
        }
        if (enabled("Item Count HUD")) {
            int count = mc.player.getMainHandItem().getCount();
            textLine(g, mc, "Held stack: " + (mc.player.getMainHandItem().isEmpty() ? "Empty" : count), 8, y, WHITE); y += line;
        }
        if (enabled("Health HUD")) { textLine(g, mc, String.format("Health: %.1f / %.1f", mc.player.getHealth(), mc.player.getMaxHealth()), 8, y, WHITE); y += line; }
        if (enabled("Hunger HUD")) { textLine(g, mc, "Hunger: " + mc.player.getFoodData().getFoodLevel() + " / 20", 8, y, WHITE); y += line; }
        if (enabled("XP Level HUD")) { textLine(g, mc, "XP Level: " + mc.player.experienceLevel, 8, y, WHITE); y += line; }
        if (enabled("Held Item Name")) { textLine(g, mc, "Holding: " + (mc.player.getMainHandItem().isEmpty() ? "Nothing" : mc.player.getMainHandItem().getHoverName().getString()), 8, y, WHITE); y += line; }
        if (enabled("Velocity HUD")) { textLine(g, mc, String.format("Velocity: %.2f", mc.player.getDeltaMovement().length()), 8, y, WHITE); y += line; }
        if (enabled("Player Name HUD")) { textLine(g, mc, "Player: " + mc.player.getGameProfile().name(), 8, y, WHITE); y += line; }
        if (enabled("Sprint Status")) { textLine(g, mc, "Sprint: " + (mc.player.isSprinting() ? "ON" : "OFF"), 8, y, WHITE); y += line; }
        if (enabled("Sneak Status")) { textLine(g, mc, "Sneak: " + (mc.player.isShiftKeyDown() ? "ON" : "OFF"), 8, y, WHITE); y += line; }
        if (enabled("Target Info")) {
            String target = mc.hitResult == null ? "None" : mc.hitResult.getType().name();
            textLine(g, mc, "Target: " + target, 8, y, WHITE); y += line;
        }
        if (enabled("Death Counter")) { textLine(g, mc, "Deaths this session: " + deathCount, 8, y, WHITE); y += line; }
        if (enabled("World Name") && mc.level != null) { textLine(g, mc, "World: " + (mc.getSingleplayerServer() != null ? mc.getSingleplayerServer().getWorldData().getLevelName() : "Multiplayer"), 8, y, WHITE); y += line; }
        if (enabled("Dimension Info") && mc.level != null) { textLine(g, mc, "Dimension: " + mc.level.dimension().identifier().toString(), 8, y, WHITE); y += line; }
        if (enabled("Block Target Info") && mc.hitResult instanceof net.minecraft.world.phys.BlockHitResult blockHit) { textLine(g, mc, "Block: " + mc.level.getBlockState(blockHit.getBlockPos()).getBlock().toString(), 8, y, WHITE); y += line; }
        if (enabled("Entity Target Name") && mc.hitResult instanceof net.minecraft.world.phys.EntityHitResult entityHit) { textLine(g, mc, "Entity: " + entityHit.getEntity().getName().getString(), 8, y, WHITE); y += line; }
        if (enabled("Held Item Durability") && !mc.player.getMainHandItem().isEmpty()) { var stack = mc.player.getMainHandItem(); textLine(g, mc, "Durability: " + (stack.getMaxDamage() - stack.getDamageValue()) + " / " + stack.getMaxDamage(), 8, y, WHITE); y += line; }
        if (enabled("Food Saturation Hint")) { textLine(g, mc, "Food level: " + mc.player.getFoodData().getFoodLevel() + "/20", 8, y, WHITE); y += line; }
        if (enabled("Cosmetic Nametag")) {
            textLine(g, mc, "✿ " + mc.player.getGameProfile().name() + " ✿", Math.max(8, (width - mc.font.width("✿ " + mc.player.getGameProfile().name() + " ✿")) / 2), 8, accent);
        }
        if (enabled("Crosshair Dot")) g.fill(width / 2 - 1, height / 2 - 1, width / 2 + 2, height / 2 + 2, accent);
        if (enabled("Keystrokes HUD")) drawKeystrokes(g, mc, width, height, accent);
        if (enabled("Module List")) drawModuleList(g, mc, width, accent);
        if (menuOpen) drawMenu(g, mc, width, height, accent);
    }

    private static void textLine(GuiGraphicsExtractor g, Minecraft mc, String text, int x, int y, int color) {
        g.text(mc.font, text, x, y, color, true);
    }

    private static void drawKeystrokes(GuiGraphicsExtractor g, Minecraft mc, int width, int height, int accent) {
        int x = width - 82, y = height - 92;
        String[] keys = {"W", "A", "S", "D"};
        boolean[] down = {mc.options.keyUp.isDown(), mc.options.keyLeft.isDown(), mc.options.keyDown.isDown(), mc.options.keyRight.isDown()};
        int[] xs = {x + 27, x, x + 27, x + 54};
        int[] ys = {y, y + 27, y + 27, y + 27};
        for (int i = 0; i < keys.length; i++) {
            g.fill(xs[i], ys[i], xs[i] + 24, ys[i] + 23, down[i] ? 0xFF503047 : CARD);
            g.fill(xs[i], ys[i], xs[i] + 24, ys[i] + 1, accent);
            g.text(mc.font, keys[i], xs[i] + 8, ys[i] + 7, WHITE, true);
        }
        boolean jumping = mc.options.keyJump.isDown();
        g.fill(x, y + 54, x + 78, y + 77, jumping ? 0xFF503047 : CARD);
        g.text(mc.font, "SPACE", x + 25, y + 61, WHITE, true);
    }

    private static void drawModuleList(GuiGraphicsExtractor g, Minecraft mc, int width, int accent) {
        int y = 8;
        for (var entry : MODULES.entrySet()) {
            if (entry.getValue() && !entry.getKey().equals("Module List") && !entry.getKey().equals("Pink Accent")
                && !entry.getKey().equals("Compact HUD")) {
                String name = entry.getKey();
                int x = width - mc.font.width(name) - 12;
                g.fill(x - 5, y - 2, width - 6, y + 10, 0x99201725);
                g.fill(width - 8, y - 2, width - 6, y + 10, accent);
                g.text(mc.font, name, x, y, WHITE, true);
                y += 13;
            }
        }
    }

    private static void drawMenu(GuiGraphicsExtractor g, Minecraft mc, int screenW, int screenH, int accent) {
        int left = Math.max(12, (screenW - 500) / 2);
        int top = Math.max(12, (screenH - 326) / 2);
        g.fill(left + 4, top + 5, left + 504, top + 330, 0x77000000);
        g.fill(left, top, left + 500, top + 326, PANEL);
        g.fill(left, top, left + 500, top + 3, accent);
        g.text(mc.font, "ROSECLIENT", left + 16, top + 13, accent, true);
        g.text(mc.font, "VISUAL CLIENT  •  Right Shift to close", left + 126, top + 13, MUTED, true);
        g.text(mc.font, "Owner: AvoidMyNicoYT", left + 345, top + 13, WHITE, true);

        String[] tabs = {"HUD & INFO", "VISUALS", "QUALITY", "TOOLS"};
        for (int i = 0; i < tabs.length; i++) {
            int x = left + 16 + i * 116;
            boolean selected = i == activeCategory;
            g.fill(x, top + 42, x + 108, top + 68, selected ? 0xFF503047 : CARD);
            if (selected) g.fill(x, top + 65, x + 108, top + 68, accent);
            g.text(mc.font, tabs[i], x + 7, top + 51, selected ? WHITE : MUTED, true);
        }
        String[] names = MODULES.keySet().toArray(new String[0]);
        int index = 0;
        for (String name : names) {
            int category = index / 8;
            int within = index % 8;
            index++;
            if (category != activeCategory) continue;
            int col = within / 4;
            int row = within % 4;
            int x = left + 16 + col * 236;
            int y = top + 82 + row * 43;
            boolean on = enabled(name);
            g.fill(x, y, x + 222, y + 34, on ? 0xFF342235 : CARD);
            g.fill(x, y, x + 3, y + 34, on ? accent : 0xFF554653);
            g.text(mc.font, name, x + 10, y + 6, WHITE, true);
            g.text(mc.font, on ? "ON" : "OFF", x + 10, y + 20, on ? accent : MUTED, true);
            int pillX = x + 183;
            g.fill(pillX, y + 10, pillX + 28, y + 24, on ? accent : 0xFF5B4D59);
            g.fill(pillX + (on ? 15 : 2), y + 12, pillX + (on ? 26 : 13), y + 22, 0xFFFFFFFF);
        }
        g.fill(left + 16, top + 270, left + 238, top + 302, 0xFF3A2939);
        g.text(mc.font, "Reset visual preset", left + 29, top + 281, WHITE, true);
        g.fill(left + 262, top + 270, left + 484, top + 302, 0xFF3A2939);
        g.text(mc.font, "Close menu", left + 331, top + 281, WHITE, true);
        g.text(mc.font, "Click a card to toggle it  •  Visual/QoL only", left + 16, top + 311, MUTED, true);
    }
}
