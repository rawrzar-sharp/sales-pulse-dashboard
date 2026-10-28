# Make Power BI update live (≈5 minutes)

Every add / edit / delete on the site is pushed by **server.js** to a Power BI *streaming dataset*.
It is the server that talks to Power BI, so it does not matter whether the change was made on
`localhost` or by a friend through Cloudflare — Power BI gets it either way.

## 1. Create the streaming dataset (once, in the Power BI service)

1. app.powerbi.com → your workspace → **+ New** → **Streaming dataset** → **API** → Next.
2. Dataset name: `SalesPulseStream`.
3. Add these 16 fields, exactly this spelling and type (also in `powerbi-fields.json`):

| Name | Type | | Name | Type |
|---|---|---|---|---|
| EventTime | DateTime | | Orders | Number |
| ChangeType | Text | | Quantity | Number |
| RecordId | Text | | UnitPrice | Number |
| OrderTime | DateTime | | TotalSales | Number |
| Region | Text | | Completed | Number |
| Category | Text | | Rated | Number |
| Product | Text | | RatingSum | Number |
| Status | Text | | | |
| UpdatedBy | Text | | | |

4. Switch **Historic data analysis** to **On** (this is what lets you build reports, not only live tiles).
5. Click **Create** and copy the **Push URL** (it looks like `https://api.powerbi.com/beta/…/datasets/…/rows?key=…`).
   The key is a password: anyone with the URL can write to the dataset.

## 2. Start the server with the push URL

```bash
# macOS / Linux
POWERBI_PUSH_URL="https://api.powerbi.com/beta/....rows?key=...." EDIT_KEY=choose-a-secret node server.js

# Windows PowerShell
$env:POWERBI_PUSH_URL="https://api.powerbi.com/beta/....rows?key=...."; $env:EDIT_KEY="choose-a-secret"; node server.js
```

On first start it sends your existing rows once (a "backfill"). Check the **Power BI** tab → *Live push to Power BI*:
it should say **On · Sent N rows · last push 2 s ago**. Press **Simulate** on the site and watch "Sent" climb.
If you ever delete the dataset and make a new one, start once with `POWERBI_BACKFILL=1` to send the rows again.

## 3. Build the live visuals

**Dashboard tiles update by themselves** — easiest way to see it live:

1. In the workspace, open `SalesPulseStream` → **Create report** → build visuals using the measures below
   (or use *Dashboard → Add tile → Custom streaming data → SalesPulseStream* for instant card/line tiles).
2. Pin the visuals to a **dashboard**. Pinned tiles refresh as data arrives.
3. To show it inside this site, open the dashboard and use its embed link
   (`https://app.powerbi.com/dashboardEmbed?dashboardId=…&autoAuth=true&ctid=…`), paste it in the **Power BI** tab box.
   If your tenant does not give you a dashboard embed link, keep the report embed and press the report's *Refresh* button.

**Reports** show new rows when the report is refreshed. In Power BI service you can turn on
*Edit → Page → Page refresh* (Fixed interval, e.g. 5 s); whether this is available for a push dataset depends on your
license/tenant settings — please test it in your tenant.

### Why the numbers are "signed"

A push URL can only **append** rows. So an edit sends two rows (old values × −1, new values × +1) and a delete
sends one (old values × −1). Therefore a plain `SUM` is always the current truth:

| Measure | DAX (table `SalesPulseStream`) |
|---|---|
| Total sales | `SUM(SalesPulseStream[TotalSales])` |
| Orders | `SUM(SalesPulseStream[Orders])` |
| Avg order value | `DIVIDE([Total sales],[Orders])` |
| Completion rate | `DIVIDE(SUM(SalesPulseStream[Completed]),[Orders])` |
| Avg rating | `DIVIDE(SUM(SalesPulseStream[RatingSum]),SUM(SalesPulseStream[Rated]))` |

Slice by `Region`, `Category`, `Product`, `Status` and `OrderTime`. Do **not** use `COUNTROWS` (it counts the reversal rows too).
These sums match the KPI cards on the Overview tab (the automated tests check exactly this).

## Cloudflare notes

* `cloudflared tunnel --url http://localhost:3000` (a *quick tunnel*) **does not support Server-Sent Events**
  (Cloudflare documents this). The site detects it and falls back to checking the server every ~1.5 s, so changes
  still appear for everyone within about 2 s. The pill's tooltip says "polling" when this is the case.
* A **named tunnel** (free Cloudflare account + your own domain) supports SSE → instant updates. Same command line otherwise.
* Quick tunnels also change address every time you start them and have no uptime guarantee: fine for demos, not for production.

## Limits & troubleshooting

| Symptom | Likely cause |
|---|---|
| Status says *Power BI rejected the rows (400)* | Field names/types do not match the table above |
| *rejected (404)* | Push URL copied wrongly, or dataset deleted |
| *answered 429 / cannot reach Power BI — retrying* | Rate limit or network; rows are queued and retried automatically (backoff up to 30 s) |
| Rows lost after a crash | The queue lives in memory; restart with `POWERBI_BACKFILL=1` **after deleting the old dataset rows** (or recreate the dataset) |
| Embedded report blank | Not signed in to Microsoft in this browser, or third-party cookies blocked |
