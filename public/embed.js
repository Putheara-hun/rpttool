/*!
 * ReportTool embed helper — put the report designer inside any web application.
 *
 *   <div id="designer" style="height: 700px"></div>
 *   <script src="https://reports.example.com/embed.js"></script>
 *   <script>
 *     const designer = ReportTool.embed(document.getElementById('designer'), {
 *       format: 'xml',                       // 'json' (design) | 'xml' (RDL) | 'html' (report + design)
 *       formats: ['xml', 'html'],            // formats the user may choose when saving (optional)
 *       onSave: async (out) => {             // the user clicked Save
 *         await fetch('/api/reports/42', { method: 'PUT', headers: { 'Content-Type': out.mimeType }, body: out.content });
 *       },
 *       onChange: (dirty) => {},             // unsaved changes yes / no
 *     });
 *     designer.load(textFromYourDatabase);    // json, xml (RDL) or html text saved earlier
 *     const out = await designer.getOutput('html');   // the report as text at any time
 *   </script>
 *
 * out = { format, content, mimeType, name, fileName, extraFiles: [{ name, content }], warnings }
 * If onSave throws (or returns a rejected promise) the designer shows the error and keeps the changes unsaved.
 */
(function () {
  var script = document.currentScript;
  var DEFAULT_URL = script && script.src ? new URL('./', script.src).href : location.origin + '/';

  function embed(container, opts) {
    opts = opts || {};
    if (!container) throw new Error('ReportTool.embed: container element missing');
    var url = new URL(opts.url || DEFAULT_URL, location.href);
    url.searchParams.set('embed', '1');
    url.searchParams.set('origins', location.origin); // only this page may talk to the designer
    if (opts.format) url.searchParams.set('format', opts.format);
    if (opts.formats) url.searchParams.set('formats', [].concat(opts.formats).join(','));
    if (opts.saveLabel) url.searchParams.set('saveLabel', opts.saveLabel);
    if (opts.title) url.searchParams.set('title', opts.title);

    var iframe = document.createElement('iframe');
    iframe.src = url.href;
    iframe.title = opts.title || 'Report designer';
    iframe.setAttribute('allow', 'clipboard-read; clipboard-write');
    iframe.style.cssText = 'width:100%;height:100%;border:0;display:block;';
    container.appendChild(iframe);

    var target = url.origin;
    var seq = 0;
    var pending = {};
    var resolveReady;
    var ready = new Promise(function (r) {
      resolveReady = r;
    });

    function post(type, data) {
      var msg = Object.assign({ type: 'reporttool:' + type }, data || {});
      iframe.contentWindow.postMessage(msg, target);
    }
    function request(type, data) {
      return ready.then(function () {
        return new Promise(function (resolve, reject) {
          var id = 'r' + ++seq;
          pending[id] = { resolve: resolve, reject: reject };
          post(type, Object.assign({}, data || {}, { requestId: id }));
        });
      });
    }

    function onMessage(e) {
      if (e.source !== iframe.contentWindow || e.origin !== target) return;
      var m = e.data;
      if (!m || typeof m.type !== 'string' || m.type.indexOf('reporttool:') !== 0) return;
      var type = m.type.slice(11);
      if (m.requestId && pending[m.requestId]) {
        var p = pending[m.requestId];
        delete pending[m.requestId];
        if (type === 'error') p.reject(new Error(m.message));
        else p.resolve(m);
        return;
      }
      if (type === 'ready') {
        // options that must not travel in the URL (save address, tokens)
        if (opts.saveUrl || opts.saveHeaders) post('init', { saveUrl: opts.saveUrl || '', saveHeaders: opts.saveHeaders || {} });
        resolveReady(m);
        if (opts.onReady) opts.onReady(m);
      } else if (type === 'save') {
        if (!opts.onSave) return;
        Promise.resolve()
          .then(function () {
            return opts.onSave(m);
          })
          .then(
            function () {
              post('saved', { ok: true });
            },
            function (err) {
              post('saved', { ok: false, message: (err && err.message) || String(err) });
            },
          );
      } else if (type === 'saved') {
        if (opts.onSaved) opts.onSaved(m);
      } else if (type === 'changed') {
        if (opts.onChange) opts.onChange(!!m.dirty);
      } else if (type === 'error') {
        if (opts.onError) opts.onError(new Error(m.message));
      }
    }
    window.addEventListener('message', onMessage);

    return {
      iframe: iframe,
      /** resolves when the designer has started */
      ready: ready,
      /** open a report: text (json / xml (RDL) / html) or a JSON object */
      load: function (content, o) {
        o = o || {};
        return request('load', { content: content, format: o.format, name: o.name });
      },
      /** start an empty report */
      newReport: function (name) {
        return request('new', { name: name });
      },
      /** the report as text: format 'json' | 'xml' | 'html' (default: the chosen format) */
      getOutput: function (format) {
        return request('getOutput', { format: format });
      },
      /** rows from your system as a data source of the report (its fields appear in the Field List) */
      setData: function (name, rows, fields) {
        return request('setData', { name: name, rows: rows, fields: fields });
      },
      /** formats the user may choose / the selected format */
      setFormats: function (formats, format) {
        return request('init', { formats: formats, format: format });
      },
      destroy: function () {
        window.removeEventListener('message', onMessage);
        iframe.remove();
      },
    };
  }

  window.ReportTool = { embed: embed, version: 1 };
})();
