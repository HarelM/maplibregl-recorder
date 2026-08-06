import { MaplibreRecorder, RECORDER_UI_FLAG, type Recorder } from './recorder';
import { emitScript } from './emit';
import { buildReproPage } from './page';

/**
 * The record/export panel, as a MapLibre control.
 *
 * It is the front end onto a {@link Recorder}, and the direction only goes one
 * way: the control reaches into the engine through the same public API anyone
 * else would use, follows its state through {@link Recorder.onChange}, and the
 * engine knows nothing about it. Turning a recording into a page and putting
 * that page somewhere - a file, the clipboard, a new tab, CodePen - lives here
 * too, because it is all browser plumbing rather than recording.
 *
 * Needs `dist/maplibregl-recorder.css` in the page.
 *
 * @example
 * ```js
 * map.addControl(new RecorderControl(), 'bottom-right');
 * ```
 */
export class RecorderControl {
    private _recorder: Recorder;
    private _container: HTMLElement | null = null;
    private _unsubscribe: (() => void) | null = null;
    private _buttons: Record<string, HTMLButtonElement> = {};

    /**
     * @param recorder - the recorder to drive. Defaults to the shared
     * {@link MaplibreRecorder} instance, which is the one you normally attach.
     */
    constructor(recorder: Recorder = MaplibreRecorder) {
        this._recorder = recorder;
        // So the recorder can leave `map.addControl(<this>)` out of the
        // reproduction: its own panel is not part of the bug.
        (this as any)[RECORDER_UI_FLAG] = true;
    }

    /** The recorder this control drives. */
    get recorder(): Recorder {
        return this._recorder;
    }

    // -----------------------------------------------------------------
    // IControl
    // -----------------------------------------------------------------

    /** Where MapLibre puts the control when no position is given. */
    getDefaultPosition(): string {
        return 'bottom-right';
    }

    /**
     * Builds the panel. Called by `map.addControl`.
     *
     * @param _map - the map the control was added to
     * @returns the control's element
     */
    onAdd(_map?: any): HTMLElement {
        this._container = document.createElement('div');
        this._container.className = 'maplibregl-ctrl maplibregl-ctrl-recorder';

        this._addButton('toggle', 'icon-record', 'Record', () => {
            this._recorder.isRecording ? this._recorder.stop() : this._recorder.start();
        });
        this._addButton('note', 'icon-note', 'Add a note', () => {
            const label = prompt('What is on screen right now?', 'the bug is visible here');
            if (label) this._recorder.mark(label);
        });
        this._addButton('clear', 'icon-clear', 'Discard the recording', () => this._recorder.clear());
        this._addButton('export', 'icon-export', 'Export the reproduction', () => this.download());

        this._unsubscribe = this._recorder.onChange(() => this.update());
        this.update();
        return this._container;
    }

    /** Tears the panel down. Called by `map.removeControl`. */
    onRemove(_map?: any): void {
        this._unsubscribe?.();
        this._unsubscribe = null;
        this._container?.remove();
        this._container = null;
        this._buttons = {};
    }

    /** Redraws the panel from the recorder's current state. */
    update(): this {
        if (!this._container) return this;
        const recording = this._recorder.isRecording;
        const count = this._recorder.ops.length;

        const toggle = this._buttons['toggle']!;
        toggle.classList.toggle('recording', recording);
        toggle.firstElementChild!.className = recording ? 'icon-pause' : 'icon-record';
        label(toggle, recording ? `Pause recording (${count} calls so far)` : `Record (${count} calls so far)`);

        // Nothing to throw away or export until something has been recorded.
        this._buttons['clear']!.disabled = count === 0;
        this._buttons['export']!.disabled = count === 0;
        return this;
    }

    private _addButton(name: string, icon: string, title: string, onClick: () => void) {
        const button = document.createElement('button');
        button.type = 'button';
        button.dataset['action'] = name;
        label(button, title);
        const span = document.createElement('span');
        span.className = icon;
        button.appendChild(span);
        button.onclick = onClick;
        this._container!.appendChild(button);
        this._buttons[name] = button;
    }

    // -----------------------------------------------------------------
    // Export
    // -----------------------------------------------------------------

    /** A standalone HTML page that makes the recorded calls. */
    toHTML(): string {
        return buildReproPage(this._recorder.toJSON());
    }

    /** Just the JavaScript of the reproduction, without the page around it. */
    toScript(): string {
        return emitScript(this._recorder.toJSON());
    }

    /**
     * Saves the reproduction page to disk.
     * @param filename - name of the downloaded file
     * @returns the control, for chaining
     */
    download(filename: string = 'maplibre-repro.html'): this {
        return this._save(filename, this.toHTML(), 'text/html');
    }

    /**
     * Saves the raw recording to disk, for later inspection or re-export.
     * @param filename - name of the downloaded file
     * @returns the control, for chaining
     */
    downloadJSON(filename: string = 'maplibre-recording.json'): this {
        return this._save(filename, JSON.stringify(this._recorder.toJSON(), null, 1), 'application/json');
    }

    /** Copies the reproduction page to the clipboard, ready to paste into JS Bin. */
    copy(): Promise<void> {
        const html = this.toHTML();
        if (!navigator.clipboard?.writeText) {
            return Promise.reject(new Error('[maplibregl-recorder] clipboard unavailable - use download()'));
        }
        return navigator.clipboard.writeText(html)
            .then(() => log(`reproduction copied to clipboard (${Math.round(html.length / 1024)} KB)`));
    }

    /** Opens the reproduction page in a new tab. */
    open(): this {
        const url = URL.createObjectURL(new Blob([this.toHTML()], {type: 'text/html'}));
        window.open(url, '_blank');
        return this;
    }

    /** Opens the reproduction in CodePen, using its prefill API. */
    openInCodePen(): this {
        const form = document.createElement('form');
        form.method = 'POST';
        form.action = 'https://codepen.io/pen/define';
        form.target = '_blank';
        const input = document.createElement('input');
        input.type = 'hidden';
        input.name = 'data';
        input.value = JSON.stringify({
            title: 'MapLibre GL JS reproduction',
            html: buildReproPage(this._recorder.toJSON(), true),
            editors: '1000'
        });
        form.appendChild(input);
        document.body.appendChild(form);
        form.submit();
        form.remove();
        return this;
    }

    private _save(filename: string, content: string, mimeType: string): this {
        const url = URL.createObjectURL(new Blob([content], {type: mimeType}));
        const link = document.createElement('a');
        link.href = url;
        link.download = filename;
        document.body.appendChild(link);
        link.click();
        link.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
        log(`saved ${filename} (${Math.round(content.length / 1024)} KB)`);
        return this;
    }
}

function log(message: string) {
    console.log(`[maplibregl-recorder] ${message}`);
}

/** The tooltip and the accessible name are the same thing for an icon button. */
function label(button: HTMLButtonElement, text: string) {
    button.title = text;
    button.setAttribute('aria-label', text);
}
