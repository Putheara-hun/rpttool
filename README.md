# ReportTool — Report Designer (Vue 3)

A browser-based banded report designer in the style of DevExpress / Stimulsoft / Crystal Reports:
design a layout, bind it to data, group and summarize, preview with real pagination, then print or export.

## Run

```bash
npm install
npm run dev        # designer + database service at http://localhost:5173
npm run build      # type-check + production build into dist/
npm start          # serve the production build + database service at http://localhost:5174
```

## Copy the report as text (store it in your own system)

The simplest way to keep reports in another system: no integration needed.

- **Copy Text** (title bar, top right) → choose **XML (RDL)**, **HTML** or **JSON** → **Copy to clipboard**, then paste the
  text into your system (e.g. an `NVARCHAR(MAX)` column). Copying counts as saving (the • unsaved mark goes away).
- **Open from text** (clipboard icon next to Open, or Save ▾ → Open from Text) → paste the text → **Open report** to edit it
  again. All three formats keep the full design; RDL from Report Builder / SSRS can be pasted too.
- XML (RDL) also opens in SQL Server Reporting Services / Report Builder; HTML is the finished report with its data
  (prints from any browser); JSON is the smallest.

## Report Viewer (text → report)

`/viewer` (or `/viewer.html`) shows a report from its **text** — the XML (RDL), HTML or JSON copied with
**Copy Text**, or an RDL file from Report Builder — with pages, zoom, find, parameters, refresh, print and export
(PDF, Excel, CSV, HTML, PNG). Nothing can be edited there.

- **By hand:** open `/viewer`, paste the text (or open / drop a file) → **Show report**.
- **From your system** (`viewer.js`, next to the viewer):
  ```html
  <div id="report" style="height: 80vh"></div>
  <script src="https://<your-site>/viewer.js"></script>
  <script>
    const viewer = ReportViewer.embed(document.getElementById('report'), {
      report: textFromYourDatabase,          // XML / HTML / JSON
      data: { DataSet1: rows },             // optional: rows per data source NAME in the design
      params: { TITLE: 'Loan Outstanding' } // optional: parameter values ({?TITLE} works even if not declared)
    });
    // later: viewer.load(text, { data, params }), viewer.setData(name, rows), viewer.setParams({...}),
    //        viewer.refresh(), viewer.print(), viewer.exportAs('pdf' | 'xlsx' | 'csv' | 'html' | 'png')
  </script>
  ```
  `ReportViewer.open({ report, data, params })` shows it in a new browser tab instead (call it from a click).
- **Where the rows come from:** rows sent by your system win; otherwise the data saved in the text (JSON / CSV
  sources, rows sent while designing); otherwise a database source runs through this site's server when the
  browser has that connection (designer and viewer on the same site), found by id or by connection name.
- Showing it **inside** another site's page (iframe) needs that site's address in `REPORTTOOL_FRAME_ANCESTORS`
  (e.g. `https://erp.example.com`); a new tab needs nothing. Only the page that opened the viewer can talk to it.

## Embed the designer in another system (design only, output as text)

The host system shows the designer in an iframe; when the user clicks **Save** the designer hands the report back
as **text** and the host stores it in its own database. Try `http://localhost:5173/embed-demo.html`.

```html
<div id="designer" style="height: 700px"></div>
<script src="https://reports.example.com/embed.js"></script>
<script>
  const designer = ReportTool.embed(document.getElementById('designer'), {
    format: 'xml',                    // 'json' (design) | 'xml' (RDL) | 'html' (report + design)
    formats: ['xml', 'html'],         // what the user may choose next to Save (optional)
    onSave: async (out) => {          // out = { format, content, mimeType, name, fileName, extraFiles, warnings }
      await fetch('/api/reports/42', { method: 'PUT', headers: { 'Content-Type': out.mimeType }, body: out.content });
    },                                // throw -> the designer shows the error and keeps the changes unsaved
    onChange: (dirty) => {},
  });
  await designer.load(textFromYourDatabase);           // json / xml / html text saved before
  await designer.setData('Loans', rowsFromYourSystem);  // fields for the design + data for the preview
  const out = await designer.getOutput('html');          // the report as text at any time
</script>
```

- Instead of `onSave` the designer can POST the text itself: `saveUrl: '/api/reports/42', saveHeaders: { Authorization: 'Bearer …' }`
  (the host API must allow CORS from the designer's address). Headers `X-ReportTool-Format` / `X-ReportTool-Name` are sent.
- Without the helper: open `https://reports.example.com/?embed=1&origins=https://your-system.example.com` and use
  `postMessage` — messages `reporttool:load / new / getOutput / setData / setFormat / init / saved` to the designer,
  `reporttool:ready / save / changed / saved / error` (+ answers with the request's `requestId`) from it
  (see `src/embed/bridge.ts`). Only pages from `origins` (default: the embedding page) are answered.
- Embed mode hides New / Open / file Save and does not keep reports in the browser.
- Server settings (`npm start`): `HOST=0.0.0.0`, `PORT`, `REPORTTOOL_FRAME_ANCESTORS="https://erp.example.com …"`
  (sites allowed to show the designer), `REPORTTOOL_DISABLE_DB=1` (no database access — the host sends the data),
  `REPORTTOOL_ALLOWED_HOSTS=reports.example.com` (only if the database API must be reachable under that name).

### Host on Render (with database connections)

`render.yaml` runs ReportTool's server on Render (web service `reporttool-server`): the designer plus database
connections. Render ▸ the service ▸ **Environment**: `HOST=0.0.0.0`, `NODE_VERSION=22`, and **one** of

- `REPORTTOOL_PUBLIC=1` — **free for everyone**, no sign-in. Every browser gets its own **private** list of
  connections (an anonymous cookie): other visitors cannot see, use, change or delete them. Only database servers on
  the public internet can be reached (no localhost / private networks / SQLite files), at most 20 connections per
  browser and 30 connection tests per address in 10 minutes.
- `REPORTTOOL_PASSWORD=…` — **a team**: people sign in once per browser (7 days) and share one list of connections.
  After 10 wrong passwords an address is locked for 15 minutes. Optional `REPORTTOOL_CONNECTIONS` pre-fills the list
  with their passwords, as JSON: `[{"name":"Sales","provider":"mssql","host":"db.example.com","port":1433,"database":"SalesDB","user":"report_reader","password":"…","trustServerCertificate":true}]`
  (they survive restarts and cannot be changed or deleted in the designer; ignored in public mode).

Then:
1. Your database server must accept connections from Render's outbound addresses (Render: service ▸ Connect ▸ Outbound).
2. Use a **read-only** database login (e.g. only `db_datareader`): whoever uses a connection can run any SQL with it
   (Custom SQL query).

Notes: free plan = the service sleeps after 15 minutes without visitors (first visit then ~1 minute) and connections
added in the designer are lost (memory only) — creating one again with the same details reconnects saved reports.
Change the password or connections later in Render ▸ Environment (changing the password signs everybody out).
With neither `REPORTTOOL_PUBLIC` nor `REPORTTOOL_PASSWORD` the server refuses database access from the internet.

## Save as HTML or RDL

Title bar ▸ **Save ▾** (next to the Save button):

| Format | What you get |
|---|---|
| **.rptx** | ReportTool design (JSON) — Save / Save As |
| **.html** | The report **with data**, page by page, with a Print button — opens in any browser, can be e-mailed. The design is stored inside, so ReportTool opens it again (Ctrl+O). |
| **.rdl** | Report Definition Language for **SQL Server Reporting Services** 2008 R2 … 2022, Report Builder, Power BI Report Builder and Visual Studio report projects (RDL 2010 schema). |

RDL conversion:
- Report Header / Footer → rectangles; groups + Detail → a list (tablix) with group header / footer rows;
  "once" Detail Report sections → further tables; "per row" sections → **subreports** (extra `.rdl` files,
  also delivered together in a `_rdl.zip` — keep them in one folder / report server folder).
- Expressions → VB (`[X]` → `Fields!X.Value`, `?P` → `Parameters!P.Value`, `Sum([X])` with the right scope,
  running totals → `RunningValue`, `{expr}` text → `="…" & …`), format strings, conditional formatting (`IIf`),
  visibility, page numbers, charts, cross tabs (matrix), pictures, shapes / barcodes (as images), watermark.
- Database sources → data source + data set (SQL Server, Oracle; PostgreSQL / MySQL / SQLite via ODBC).
  **No user name or password is written** — enter credentials in Report Builder / on the report server.
  JSON / CSV / sample data is embedded in the RDL (XML data provider).
- A list of notes is shown after saving (anything RDL cannot express).
- Opening an `.rdl` (Ctrl+O): files saved by ReportTool reopen exactly; if the RDL was changed in Report
  Builder you choose between the changed RDL and the original design. Other SSRS / Report Builder reports are
  imported (tables, row groups, lists, text boxes, images, lines, charts, matrices, data sets, parameters,
  filters, sorting, VB expressions); a list of notes shows what needs attention.

## Fonts (Google Fonts)

The font box (Home ▸ Font, Properties ▸ Font, Styles) lists the fonts used in the report, **Google Fonts** —
including Khmer fonts (Kantumruy Pro, Noto Sans Khmer, Battambang, Hanuman, Siemreap, Moul, Koulen, Bayon, …),
popular sans / serif / mono / display fonts — and the fonts installed on the computer. Type to search; type any
other family name from fonts.google.com and choose **Use Google font “…”** to add it to the report.
Google fonts are downloaded when used (internet needed), text is measured after the font arrives, and the font is
loaded again when the report is opened. Print, saved HTML (links the font), PNG (font embedded) and PDF (text in a
Google font is drawn as an image, like Khmer text) use the font; for RDL the font must be installed on the server.

## Table columns

- Right-click a table ▸ **Column Widths** ▸ **Equal Widths** (all columns, or the selected cells' columns),
  **Match Other Tables to This One** (the other tables — or the other *selected* tables — take this table's column
  lines, e.g. Page Header / Detail / Report Footer), **Fit to Page Width**. Also in Layout ▸ Table and Home ▸ Table ▸ Columns ▾.
- Lines and borders are drawn as sharp single pixels at every zoom, and shared table lines are drawn once.

## Row numbers, page numbers, column widths

- **Row No. (1, 2, 3 …)**: double-click the empty cell of the NO column ▸ *Special* ▸ **Row No.** (or right-click the
  cell ▸ Row No., or drag it from Field List ▸ Special Fields). With groups there is also *Row No. in group*.
- **Page numbers**: right-click the Page Footer (or Page Header) ▸ **Insert Page Number (Page 1 of N)**; or
  Special ▸ *Page N of M / Page number / Total pages / Today's date* for a cell or label.
- **Column width / row height**: move the mouse onto a line between two columns (cursor ↔) and drag. The column
  next to it gives or takes the width, so the table keeps its width; hold **Shift** to change only that column. The
  line snaps to the column lines of the other tables (hold Alt for free movement). Row lines (cursor ↕) set row heights.

## Merge table cells

Click a table, click a cell, then **drag across cells** (or **Shift+click** another cell) to select a range, and
choose right-click ▸ **Merge Cells** (also Home ▸ Table, Layout ▸ Merge Cells, or the Merge button in Properties).
Right-click ▸ **Merge with Right Cell / Merge with Cell Below** merges in one step; **Unmerge Cells** splits again.
Merging works across columns and down rows; the first cell's content is kept. Formatting (font, colours, borders,
alignment) applies to all selected cells at once. Merged cells print as one cell and stay merged in Excel and RDL.

## Totals (grand total, group total, section total)

Right-click a table / field in the **Detail** band ▸ **Add Grand Total (Report Footer)** (or Group Total /
Section Total), or Insert ▸ **Σ Grand Total**. Number columns get `Sum()`, the first text column the caption
"Grand Total". A copy of the detail row already pasted into the footer is converted instead of duplicated.
In a header / footer band: right-click ▸ **Make Total Row** or pick Sum / Count / Average / Minimum / Maximum
for a cell.

## Copy & paste, colors

- **Ctrl+C / Ctrl+X / Ctrl+V** use the system clipboard: paste controls into another band, another report or
  another browser tab. Nothing selected → paste lands at the mouse position; right-click ▸ **Paste Here**.
- Paste from other programs: **Excel cells** → table (or into the selected table cells, adding rows),
  **text** → label (`[Field]` text → data field), **screenshots / pictures** → picture control.
- Table cells: select a cell, Ctrl+C, select another cell, Ctrl+V. **Format Painter** (Home ▸ Clipboard or
  right-click) copies formatting to the next control / cell you click.
- Color pickers (ribbon font / fill / border, Properties, dialogs): theme colors with shades, standard colors,
  recent colors, *No color*, custom color (More colors… / hex) and an eyedropper (**Pick**). The ribbon colors
  also work on lines, shapes and barcodes.

## Several lists, master–detail and nested sections (Detail Reports)

Insert ▸ **Detail Report** (or right-click a band). A detail report is a section with its **own data source**,
its own **Header** (optionally repeated on every page), a **Detail** band repeated for each of its rows, and a
**Footer** for totals over its rows. Each section can be configured in Report ▸ **Detail Reports**:

| Setting | Options |
|---|---|
| Data source | any data source of the report (table, view, procedure, SQL query, JSON, CSV…) |
| Placed under | the main report, or another section (nesting to any depth) |
| Print | **Once** after all rows of the parent (independent lists) · **For every parent row** (master–detail) |
| Link fields | one or more `parent field = section field` keys (or "link by same field name") |
| Filter | any expression; `[Field]` = section row, `[Master.Field]` = parent row, `?Param` = report parameter |
| Sort | any number of sort expressions |

Examples: two unrelated tables in one report (two sections, *Once*); each employee followed by his loans
(*For every main row*, link `EMP_CODE = EMP_CODE`); customer → orders → order lines (nested sections).
In a section, the field drop-down lists that section's fields plus the parent row's fields (`[Master.…]`).
A Detail band without controls takes no space, so the main report can be just a container for sections.

## Database data sources

Report ▸ **Data Sources** ▸ **Add data source** ▸ **Database**:

1. **New connection…** — choose Microsoft SQL Server, Oracle, PostgreSQL, MySQL / MariaDB or a SQLite file,
   enter server, port, database (Oracle: service name), user and password, then **Test connection** and **Save**.
2. Browse the database: **Tables**, **Views**, **Stored Procedures**, **Functions** (with search), or pick
   **Custom SQL query** and write your own SQL.
3. Procedure / function parameters are listed automatically. In a custom query write parameters as `@Name` or
   `:Name` and click **Detect parameters**. Each parameter value is an expression (`'USA'`, `10`, `Today()`), or
   click **Report parameter** to bind it to a report parameter (`?Name`) that the preview asks for.
4. **Preview data** runs it and detects the fields; drag the fields from the Field List onto the report.

Details:
- Database access goes through a small Node service in `server/` (runs inside `npm run dev` / `npm start`).
  It only answers requests from this app on `localhost` — unless a team password is set (`REPORTTOOL_PASSWORD`,
  see *Host on Render*). A website without this service (static hosting) shows how to use CSV / JSON data instead.
- A connection created again with the same server, database and user gets the same id, so reports that used it
  find it again after a restart.
- Drivers are pure JavaScript — no Oracle Client or ODBC setup needed (`mssql`, `pg`, `mysql2`, `oracledb`
  Thin mode, Node's built-in `node:sqlite`).
- Oracle: procedures with `SYS_REFCURSOR` OUT parameters, functions returning a ref cursor, pipelined table
  functions and package procedures are supported. SQL Server: procedures return their first result set;
  table-valued and scalar functions are supported. PostgreSQL: set-returning functions.
- Report files store only the connection **name** and the query/procedure, never credentials.
- Connections are kept **in memory only** — nothing is written to disk; after a restart they are entered again.
  To keep them, start the server with `REPORTTOOL_SAVE_CONNECTIONS=1` (stored in `.reporttool/connections.json`;
  a password is written there only if you also tick *Save password*).
- All parameter values are sent as bound parameters, not concatenated into SQL.
- SQLite files are opened read-only. Use a database login with read-only rights for other databases if the
  report designers should not be able to change data.

## Features

**Designer**
- Ribbon (Home / Insert / Layout / Report / View), toolbox, field list, report explorer, property grid
- Bands: Report Header/Footer, Page Header/Footer, Group Header/Footer (nested groups), Detail
- Drag & drop from toolbox and field list, click-to-place tools, marquee selection, multi-select
- Move / resize with 8 handles, snap to grid, snap lines, keyboard nudging, band resizing
- Align, same size, distribute, z-order, lock, copy / cut / paste / duplicate, undo / redo
- In-place text editing (double-click), rulers (cm / inch / px), zoom (Ctrl+wheel)
- Context menus for controls and bands; autosave to the browser; save/open `.rptx` (JSON)

**Controls**: Label / data field, Table (cells, rows, columns), Picture, Line, Shape (rectangle, rounded,
ellipse, triangle, diamond, arrow, star), Barcode (Code 128, Code 39, EAN-13), QR code, Chart (column, bar,
line, area, pie, doughnut; series, top-N, sorting), Cross Tab / pivot, Check box, Page info (page N of M, date).

**Data**: sample data sets, JSON / CSV (paste or file), web URL; field type detection; calculated fields;
parameters (prompted in preview); filter; sorting; grouping with keep-together, repeat header, page breaks.

**Expressions**: `[Field]`, `?Param`, `Iif()`, `Format()`, string/date/math functions, aggregates
(`Sum`, `Count`, `Avg`, `Min`, `Max`, `CountDistinct`, `First`, `Last`) scoped to group / report / page,
running totals, `PageNumber()`, `PageCount()`; embed in text with `Total: {Sum([Amount])}`.
Expression editor with validation and first-row preview.

**Formatting**: .NET-style format strings (`n2`, `c`, `p0`, `yyyy-MM-dd`, `#,##0.00`, `{0:c} of {1}`),
named style sheet, conditional formatting rules, odd/even row colors, borders, padding, alignment,
can-grow / can-shrink with automatic push-down, watermark (text or image).

**Preview & export**: paginated preview with band splitting across pages, document map (bookmarks),
text search, parameters panel, zoom; Print; export to PDF (vector text), Excel (.xlsx), CSV, HTML, PNG.

**Page size**: the designer opens on a blank page. Choose the paper (A3, A4, A5, A6, B5, Letter, Legal,
Executive, Tabloid, 80 mm / 58 mm receipt rolls, or a custom size), orientation and margins from
Home ▸ Page, Page Setup, or the Report properties.
- *Auto width* — the page grows wider when a control or table goes past the right margin (and shrinks back
  to the chosen paper width when it no longer needs to). *Fit width to content* sets the paper width exactly.
- *Auto height (roll paper)* — the report prints as one continuous page whose height fits all the content.

**Wizard**: Report Wizard (data → fields → grouping → totals → paper & style).

## Project layout

```
src/
  model/      report definition types, defaults, factories
  engine/     expression language, formatting, text measurement, layout, pagination, charts, barcodes
  export/     SVG, PDF (jsPDF), XLSX/CSV, HTML, PNG, print
  data/       sample data sets, JSON/CSV/URL loading
  store/      designer state, commands, undo/redo (Vue reactivity)
  designer/   ribbon, toolbox, field list, explorer, property grid, design surface
  preview/    preview panel
  dialogs/    expression editor, data sources, group/sort, parameters, styles, wizard, ...
  wizard/     report builder used by the Report Wizard
```
