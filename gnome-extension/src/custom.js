// SPDX-License-Identifier: GPL-3.0-or-later
// Local customisation (not upstream): the island's font, background and text colours.
//
// Isle's stylesheet is white text on near-black greys. With a font or colours set, a second stylesheet is
// written from it and loaded after it, holding only the declarations that change: "Inter Variable" becomes the
// chosen font; white (and white with alpha) becomes the text colour; black and the neutral greys become the
// background mixed towards the text colour by as much as the grey was lighter than black. Top-bar rules
// (#panel…) are left alone. Cairo-painted parts follow through theme.js and palette.js.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import St from 'gi://St';

import * as Palette from './palette.js';
import * as Theme from './theme.js';

const KEYS = ['custom-font', 'custom-colors', 'custom-background', 'custom-foreground'];
const WHITE = [1, 1, 1];

/** "#rgb" or "#rrggbb" as [r, g, b] in 0..1, or null. */
export function parseHex(text) {
    let hex = (text ?? '').trim().replace(/^#/, '');
    if (/^[0-9a-f]{3}$/i.test(hex))
        hex = [...hex].map(c => c + c).join('');
    if (!/^[0-9a-f]{6}$/i.test(hex))
        return null;
    return [0, 2, 4].map(i => parseInt(hex.slice(i, i + 2), 16) / 255);
}

const toHex = rgb => `#${rgb.map(v => Math.round(Math.min(1, Math.max(0, v)) * 255).toString(16).padStart(2, '0')).join('')}`;
const toRgb255 = rgb => rgb.map(v => Math.round(v * 255)).join(', ');
const mix = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);

/** The declarations of Isle's stylesheet that change with `font` and the colours (null: unchanged). */
export function rewrite(css, {font, bg, fg}) {
    css = css.replace(/\/\*[\s\S]*?\*\//g, '');
    const recolour = value => {
        if (!fg)
            return value;
        return value
            .replace(/rgba\(\s*255\s*,\s*255\s*,\s*255\s*,\s*([\d.]+)\s*\)/g, (_, a) => `rgba(${toRgb255(fg)}, ${a})`)
            .replace(/#([0-9a-f]{6}|[0-9a-f]{3})\b/gi, (match, hex) => {
                const rgb = parseHex(hex);
                if (Math.max(...rgb) - Math.min(...rgb) > 0.02)
                    return match; // a colour (accents, signals): kept
                const level = (rgb[0] + rgb[1] + rgb[2]) / 3;
                return toHex(mix(bg, fg, level));
            })
            .replace(/(:\s*|\s)white\b/g, `$1${toHex(fg)}`)
            .replace(/(:\s*|\s)black\b/g, `$1${toHex(bg)}`);
    };
    const out = [];
    for (const [, selector, body] of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
        const sel = selector.trim();
        if (!sel || sel.startsWith('@') || /#panel\b|\.panel-button/.test(sel))
            continue;
        const changed = [];
        let strong = false;
        for (const decl of body.split(';')) {
            const at = decl.indexOf(':');
            if (at < 0)
                continue;
            const prop = decl.slice(0, at).trim();
            const value = decl.slice(at + 1).trim();
            let next = value;
            if (prop === 'font-family') {
                if (font && /Inter/i.test(value))
                    next = `"${font.replace(/"/g, '')}"${/!important/.test(value) ? ' !important' : ''}`;
            } else if (/color|shadow|border/.test(prop)) {
                next = recolour(value);
            }
            if (next !== value) {
                // Isle's own rules match as strongly and St may keep them over these: important wins.
                if (/!important/.test(value))
                    strong = true;
                else
                    next += ' !important';
                changed.push(`  ${prop}: ${next};`);
            }
        }
        if (!changed.length)
            continue;
        // Where Isle's rule is important already, a more specific selector (inside the island) wins instead.
        const target = strong
            ? sel.split(',').map(part => part.trim()).map(part =>
                part.startsWith('#isleIsland') ? `StWidget${part}` : `StWidget#isleIsland ${part}`).join(',\n')
            : sel;
        out.push(`${target} {\n${changed.join('\n')}\n}`);
    }
    return out.join('\n\n');
}

/** Keeps the custom stylesheet and colours in step with Settings; `changed` repaints the island. */
export class CustomLook {
    constructor(extension, settings, changed) {
        this._source = extension.dir.get_child('stylesheet.css');
        this._settings = settings;
        this._changed = changed;
        this._file = null;
        this._count = 0;
        this._ids = KEYS.map(key => settings.connect(`changed::${key}`, () => {
            this._apply();
            this._changed?.();
        }));
        this._apply();
    }

    _apply() {
        const font = this._settings.get_string('custom-font').trim();
        const on = this._settings.get_boolean('custom-colors');
        const bg = on ? parseHex(this._settings.get_string('custom-background')) ?? [0, 0, 0] : null;
        const fg = on ? parseHex(this._settings.get_string('custom-foreground')) ?? [1, 1, 1] : null;

        Theme.setCustomBackground(bg);
        Palette.WHITE.splice(0, 3, ...(fg ?? WHITE));

        this._unload();
        if (!font && !on)
            return;
        try {
            const [, bytes] = this._source.load_contents(null);
            const css = rewrite(new TextDecoder().decode(bytes), {font, bg: bg ?? [0, 0, 0], fg});
            if (!css)
                return;
            const dir = GLib.build_filenamev([GLib.get_user_cache_dir(), 'isle-custom']);
            GLib.mkdir_with_parents(dir, 0o755);
            // What an earlier session left (logging out never unloads it).
            const listing = Gio.File.new_for_path(dir).enumerate_children('standard::name', 0, null);
            for (let info; (info = listing.next_file(null));) {
                if (info.get_name().endsWith('.css'))
                    listing.get_child(info).delete(null);
            }
            listing.close(null);
            // A new name each time: St keeps a stylesheet it has read by its file.
            const file = Gio.File.new_for_path(GLib.build_filenamev([dir, `look-${Date.now()}-${this._count++}.css`]));
            file.replace_contents(new TextEncoder().encode(`/* Isle: custom font and colours (generated) */\n${css}\n`),
                null, false, Gio.FileCreateFlags.REPLACE_DESTINATION, null);
            St.ThemeContext.get_for_stage(global.stage).get_theme().load_stylesheet(file);
            this._file = file;
        } catch (e) {
            console.error(`Isle: custom look: ${e.message}`);
        }
    }

    _unload() {
        if (!this._file)
            return;
        try {
            St.ThemeContext.get_for_stage(global.stage).get_theme().unload_stylesheet(this._file);
        } catch (e) {}
        try {
            this._file.delete(null);
        } catch (e) {}
        this._file = null;
    }

    destroy() {
        this._ids.forEach(id => this._settings.disconnect(id));
        this._ids = [];
        this._unload();
        Theme.setCustomBackground(null);
        Palette.WHITE.splice(0, 3, ...WHITE);
    }
}
