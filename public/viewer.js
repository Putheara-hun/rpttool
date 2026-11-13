/*!
 * ReportTool Report Viewer helper — show a report (its text from your database) inside any web application.
 *
 *   <script src="https://reports.example.com/viewer.js"></script>
 *
 *   // inside a page
 *   const viewer = ReportViewer.embed(document.getElementById('report'), {
 *     report: textFromDatabase,                    // XML (RDL), HTML or JSON text copied from the designer
 *     data: { DataSet1: rows },                    // optional: rows per data source name (replace the saved data)
 *     params: { TITLE: 'Loan Outstanding' },       // optional: report parameter values
 *     labels: { rpt_print: 'Print', … },           // optional: the viewer's words (your translations)
 *     theme: 'light',                              // optional: 'light' | 'dark'
 *     layout: 'scroll',                            // optional: 'scroll' (all pages one after another) | 'page' (one at a time);
 *                                                  //   a default — the user's own choice in the toolbar wins
 *     onRendered: (pages) => {},                   // optional
 *     onRefresh: () => {},                         // optional: the user clicked Refresh (send fresh rows)
 *     onError: (err) => alert(err.message),        // optional
 *   });
 *   viewer.load(otherText, { data, params });       // show another report
 *   viewer.load(await (await fetch('/api/report/42')).json());   // or your API's { report, data, params } as is
 *   viewer.setData('DataSet1', rows);              // new rows, re-rendered
 *   viewer.setParams({ BRANCH: 'HQ' });            // new parameter values, re-rendered
 *   viewer.print();  viewer.exportAs('pdf');       // pdf | xlsx | docx | csv | html | png
 *
 *   // in a new browser tab (call it from a click, or the browser blocks the tab)
 *   ReportViewer.open({ report: textFromDatabase, data, params });
 */
(function () {
  var script = document.currentScript;
  var BASE = script && script.src ? new URL('./', script.src).href : location.origin + '/';

  function viewerUrl(opts) {
    var url = new URL((opts && opts.url) || BASE + 'viewer.html', location.href);
    url.searchParams.set('embed', '1');
    url.searchParams.set('origins', location.origin); // only this page may talk to the viewer
    return url;
  }

  /** talk to a viewer window (iframe content or tab); returns the viewer API */
  function connect(getWindow, origin, opts, onDestroy) {
    var seq = 0;
    var pending = {};
    var resolveReady;
    var ready = new Promise(function (r) {
      resolveReady = r;
    });

    function post(type, data) {
      var w = getWindow();
      if (!w) throw new Error('The report viewer was closed');
      w.postMessage(Object.assign({ type: 'reportviewer:' + type }, data || {}), origin);
    }
    function request(type, data) {
      return ready.then(function () {
        return new Promise(function (resolve, reject) {
          var id = 'v' + ++seq;
          pending[id] = { resolve: resolve, reject: reject };
          try {
            post(type, Object.assign({}, data || {}, { requestId: id }));
          } catch (e) {
            delete pending[id];
            reject(e);
          }
        });
      });
    }
    function onMessage(e) {
      if (e.source !== getWindow() || e.origin !== origin) return;
      var m = e.data;
      if (!m || typeof m.type !== 'string' || m.type.indexOf('reportviewer:') !== 0) return;
      var type = m.type.slice(13);
      if (m.requestId && pending[m.requestId]) {
        var p = pending[m.requestId];
        delete pending[m.requestId];
        if (type === 'error') p.reject(new Error(m.message));
        else p.resolve(m);
        return;
      }
      if (type === 'ready') {
        // words and theme first, so the report never shows in the wrong language / colours
        if (opts.labels || opts.theme || opts.layout) post('init', { labels: opts.labels, theme: opts.theme, layout: opts.layout });
        resolveReady(m);
        if (opts.onReady) opts.onReady(m);
      } else if (type === 'rendered') {
        if (opts.onRendered) opts.onRendered(m.pages);
      } else if (type === 'refresh') {
        if (opts.onRefresh) opts.onRefresh();
      } else if (type === 'error') {
        if (opts.onError) opts.onError(new Error(m.message));
      }
    }
    window.addEventListener('message', onMessage);

    var api = {
      ready: ready,
      /**
       * show a report: its text (XML / HTML / JSON) and o = { data, params, name, format } —
       * or one object { report, data, params, name, format } (e.g. your API's answer)
       */
      load: function (report, o) {
        if (report && typeof report === 'object' && typeof report.report === 'string') {
          o = report;
          report = report.report;
        }
        o = o || {};
        return request('load', { content: report, data: o.data, params: o.params, name: o.name, format: o.format });
      },
      /** the viewer's words, e.g. { rpt_print: '…', rpt_of: '…' } */
      setLabels: function (labels) {
        return request('init', { labels: labels });
      },
      /** 'light' | 'dark' */
      setTheme: function (theme) {
        return request('init', { theme: theme });
      },
      /** new rows: setData(rows) for the report's main data source, or setData(name, rows) for a named one */
      setData: function (name, rows) {
        if (Array.isArray(name)) {
          rows = name;
          name = null;
        }
        return request('setData', { name: name, rows: rows });
      },
      /** report parameter values; refresh = false to set them without re-rendering */
      setParams: function (values, refresh) {
        return request('setParams', { values: values, refresh: refresh !== false });
      },
      refresh: function (reloadData) {
        return request('refresh', { reloadData: !!reloadData });
      },
      print: function () {
        return request('print');
      },
      /** 'pdf' | 'xlsx' | 'docx' | 'csv' | 'html' | 'png' — the file is downloaded by the browser */
      exportAs: function (format) {
        return request('export', { format: format || 'pdf' });
      },
      destroy: function () {
        window.removeEventListener('message', onMessage);
        if (onDestroy) onDestroy();
      },
    };
    // a report given up front is shown as soon as the viewer is ready
    if (opts.report) {
      api.load(opts.report, { data: opts.data, params: opts.params, name: opts.name, format: opts.format }).catch(function (e) {
        if (opts.onError) opts.onError(e);
      });
    }
    return api;
  }

  /** the viewer inside an element of this page */
  function embed(container, opts) {
    opts = opts || {};
    if (!container) throw new Error('ReportViewer.embed: container element missing');
    var url = viewerUrl(opts);
    var iframe = document.createElement('iframe');
    iframe.src = url.href;
    iframe.title = opts.title || 'Report';
    // right-click > Copy inside the viewer writes to the clipboard
    iframe.setAttribute('allow', 'clipboard-write');
    // min-height: a container without a fixed height would otherwise give the iframe the browser's 150px
    iframe.style.cssText = 'width:100%;height:100%;min-height:480px;border:0;display:block;';
    container.appendChild(iframe);
    var api = connect(
      function () {
        return iframe.contentWindow;
      },
      url.origin,
      opts,
      function () {
        iframe.remove();
      },
    );
    api.iframe = iframe;
    return api;
  }

  /** the viewer in a new browser tab */
  function open(opts) {
    opts = opts || {};
    var url = viewerUrl(opts);
    var win = window.open(url.href, '_blank');
    if (!win) throw new Error('The browser blocked the new tab: allow pop-ups for this site, or call ReportViewer.open from a click.');
    var api = connect(
      function () {
        return win.closed ? null : win;
      },
      url.origin,
      opts,
      function () {
        if (!win.closed) win.close();
      },
    );
    api.window = win;
    return api;
  }

  window.ReportViewer = { embed: embed, open: open, version: 1 };
})();
