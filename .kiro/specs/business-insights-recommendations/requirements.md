# Requirements Document

## Introduction

The Sales Pulse dashboard currently surfaces raw metrics and charts that require analytical interpretation. Business stakeholders — regional managers, sales directors, and executives — need a dedicated layer that reads the same underlying data and translates it into plain-language recommended actions: what to act on, why, and how urgently. This feature adds a "Insights" section to the dashboard that runs a rule-based analysis engine on the live sales records and presents a prioritised list of insight cards, each with a headline finding, a short explanation in business language, and a concrete suggested action.

## Glossary

- **Dashboard**: The Sales Pulse web application served by `server.js` and rendered by `public/index.html`.
- **Insight**: A single, self-contained finding derived from sales records analysis, expressed in plain business language.
- **Insight_Engine**: The JavaScript module responsible for computing insights from sales records. Runs in the browser using data already held by the store; it has no server-side component.
- **Insight_Card**: The UI component that renders one Insight — comprising a severity badge, a headline, a one-sentence explanation, and a suggested action.
- **Insight_Panel**: The scrollable container that holds all Insight_Cards and is displayed in the new "Insights" tab.
- **Severity**: A three-level classification — `critical`, `warning`, `info` — that determines card colour, icon, and sort order.
- **Record**: One sales transaction object stored in `data/records.json` and held in memory by the store, conforming to the schema validated by `analytics.js`.
- **KPI**: A key performance indicator computed by `analytics.js` (total sales, order count, average order value, completion rate, average rating).
- **Analytics_Module**: The existing `public/js/analytics.js` module (`window.Analytics` in the browser).
- **Store**: The existing `public/js/store.js` abstraction (`window.createStore`) that provides the current records array and emits change events.
- **Active_Filter**: A date-range, region, category, or status filter currently applied on the Overview tab.
- **Trend_Window**: The rolling 7-day or 30-day period used to compare recent performance against the full dataset baseline.
- **Refund_Rate**: The share of orders with status `Refunded` out of all orders in the analysis window.
- **Cancellation_Rate**: The share of orders with status `Cancelled` out of all orders in the analysis window.
- **Completion_Rate**: The share of orders with status `Completed` out of all orders in the analysis window, as computed by `analytics.js`.
- **AOV**: Average Order Value — total sales revenue divided by total order count.

---

## Requirements

### Requirement 1: Insight Engine — Core Analysis

**User Story:** As a business stakeholder, I want the dashboard to automatically analyse the current sales data and produce a prioritised list of findings, so that I can understand what needs attention without interpreting charts myself.

#### Acceptance Criteria

1. THE Insight_Engine SHALL compute insights from the full set of records currently held by the Store, without requiring any server round-trip beyond what the Store already performs.
2. WHEN the Store emits an `upsert`, `delete`, `snapshot`, or `reset` event, THE Insight_Engine SHALL recompute all insights within 500 ms of that event.
3. THE Insight_Engine SHALL assign each Insight exactly one Severity level from the set `{critical, warning, info}`.
4. THE Insight_Engine SHALL produce at least the following insight categories, with the specified default severity when the threshold is crossed:
   - **Revenue momentum** (7-day rolling window vs prior 7-day window): `critical` when >30% decline, `warning` when 10–30% decline, `info` when flat (within ±10%) or positive.
   - **Completion rate health** (ratio of Completed orders to total non-Pending orders in the evaluated period): `critical` when <50%, `warning` when 50–64%, `info` when ≥65%.
   - **Refund / cancellation spike** (most recent 14 days, ratio to total non-Pending orders): Refund_Rate `critical` when >25%, `warning` when >15–25%; Cancellation_Rate `critical` when >30%, `warning` when >20–30%.
   - **Top-performing segment**: identifies the region or category contributing the largest share of revenue among Completed orders in the most recent 30 days; always emits as `info`.
   - **Underperforming segment**: identifies any region or category whose share of revenue among Completed orders in the most recent 30 days is more than 40% below its share in the preceding period (all data excluding the most recent 30 days), with at least 5 Completed orders in the recent window; emits as `warning`.
   - **Rating alert** (30-day window, Completed orders only, 1–5 scale): `warning` when average rating <3.0 and at least 5 rated orders; `info` otherwise.
   - **Low stock proxy**: flags any product whose order volume in the most recent 14 days is more than 2× its average 14-day order volume computed over all prior 14-day windows; emits as `info`.
5. IF the records array contains fewer than 5 records, THEN THE Insight_Engine SHALL produce a single `info`-level insight with the headline "Insufficient data for analysis" and SHALL NOT attempt to compute any other insight categories.
6. THE Insight_Engine SHALL be implemented as a pure function: given the same records array and the same reference timestamp, it SHALL always return the same set of insights (deterministic, no side-effects).
7. THE Insight_Engine SHALL expose its computation as a named export (`window.InsightEngine` in the browser, `module.exports` on Node) so it can be unit-tested independently of the UI.

---

### Requirement 2: Insight Thresholds and Classification Rules

**User Story:** As a business stakeholder, I want insights to reflect meaningful business thresholds, so that I am only alerted when something genuinely warrants attention.

#### Acceptance Criteria

1. IF the Completion_Rate (ratio of Completed orders to total non-Pending orders in the evaluated period) falls below 50%, THEN THE Insight_Engine SHALL emit a `critical`-severity insight for Completion_Rate. IF the Completion_Rate is at least 50% and below 65%, THEN THE Insight_Engine SHALL emit a `warning`-severity insight for Completion_Rate. IF the Completion_Rate is at least 65%, THEN THE Insight_Engine SHALL emit an `info`-severity insight for Completion_Rate.
2. IF the Refund_Rate (ratio of Refunded orders to total non-Pending orders in the evaluated period) exceeds 25%, THEN THE Insight_Engine SHALL emit a `critical`-severity insight for Refund_Rate. IF the Refund_Rate is greater than 15% and at most 25%, THEN THE Insight_Engine SHALL emit a `warning`-severity insight for Refund_Rate. IF the Refund_Rate is at most 15%, THEN THE Insight_Engine SHALL emit an `info`-severity insight for Refund_Rate.
3. IF the Cancellation_Rate (ratio of Cancelled orders to total non-Pending orders in the evaluated period) exceeds 30%, THEN THE Insight_Engine SHALL emit a `critical`-severity insight for Cancellation_Rate. IF the Cancellation_Rate is greater than 20% and at most 30%, THEN THE Insight_Engine SHALL emit a `warning`-severity insight for Cancellation_Rate. IF the Cancellation_Rate is at most 20%, THEN THE Insight_Engine SHALL emit an `info`-severity insight for Cancellation_Rate.
4. IF the most recent 7-day total revenue is more than 30% below the prior 7-day total revenue, THEN THE Insight_Engine SHALL emit a `critical`-severity insight for revenue momentum. IF the most recent 7-day total revenue is more than 10% and at most 30% below the prior 7-day total revenue, THEN THE Insight_Engine SHALL emit a `warning`-severity insight for revenue momentum. IF the most recent 7-day total revenue is within 10% (above or below) of the prior 7-day total revenue, or is higher, THEN THE Insight_Engine SHALL emit an `info`-severity insight for revenue momentum.
5. IF the 30-day average rating for Completed orders falls below 3.0 on a 1–5 scale and the count of rated Completed orders in that 30-day window is at least 5, THEN THE Insight_Engine SHALL emit a `warning`-severity insight for average rating. IF the 30-day average rating for Completed orders is at least 3.0 and the count of rated Completed orders in that 30-day window is at least 5, THEN THE Insight_Engine SHALL emit an `info`-severity insight for average rating.
6. IF a segment's share of total revenue among Completed orders in the most recent 30 days is more than 40% below its share of total revenue among Completed orders in the period preceding those 30 days (all data excluding the most recent 30 days), and the segment has at least 5 Completed orders in the most recent 30-day period, THEN THE Insight_Engine SHALL emit a `warning`-severity insight classifying that segment as underperforming.
7. IF the count of rated Completed orders in the evaluated 30-day window is fewer than 5, or IF fewer than 14 days of order data exist for revenue momentum calculation, THEN THE Insight_Engine SHALL emit an `info`-severity insight for that metric indicating insufficient data, and SHALL NOT emit a `warning` or `critical` insight for that metric.
8. WHERE a computed metric does not cross any `warning` or `critical` threshold, THE Insight_Engine SHALL produce an `info`-severity insight for that metric stating the metric name and its computed value, so that the Insight_Panel always displays at least one insight per monitored metric.

---

### Requirement 3: Insight Card Content Standards

**User Story:** As a business stakeholder, I want each insight to tell me what is happening, why it matters, and what I should do — in plain language — so that I can act without needing an analyst.

#### Acceptance Criteria

1. THE Insight_Card SHALL display a headline of no more than 12 words; IF the generated headline exceeds 12 words, THE Insight_Engine SHALL truncate it at the 12th word and append an ellipsis.
2. THE Insight_Card SHALL display an explanation of no more than 30 words in plain language; IF the generated explanation exceeds 30 words, THE Insight_Engine SHALL truncate it at the 30th word and append an ellipsis.
3. THE Insight_Card SHALL display a suggested action of no more than 20 words, phrased as an imperative sentence; IF the generated suggested action exceeds 20 words, THE Insight_Engine SHALL truncate it at the 20th word and append an ellipsis.
4. THE Insight_Card SHALL display the numeric evidence that triggered the insight (e.g. "Completion rate: 48% · Last 30 days").
5. THE Insight_Card SHALL display a Severity badge using the colour scheme: `critical` → `var(--bad)`, `warning` → `var(--warn)`, `info` → `var(--ok)`.
6. THE Insight_Card SHALL display the following icon alongside the Severity badge: `critical` → ⚠️, `warning` → 🔔, `info` → ✅.
7. IF an Insight_Card has Severity `info` and the metric is healthy (no threshold crossed), THE Insight_Card SHALL render with no coloured left border and with the Severity badge at 50% opacity, so it does not compete for attention with `critical` or `warning` cards.

---

### Requirement 4: Insights Tab and Panel

**User Story:** As a business stakeholder, I want a dedicated tab in the dashboard for recommended actions, so that I can jump straight to the executive summary without wading through charts.

#### Acceptance Criteria

1. THE Dashboard SHALL add a tab labelled "Insights" to the existing tab bar, positioned after the "Power BI" tab.
2. WHEN the "Insights" tab is activated, THE Insight_Panel SHALL be visible and SHALL display the current set of insights computed by the Insight_Engine.
3. WHEN the Insight_Engine produces zero insights (e.g. records array is empty), THE Insight_Panel SHALL display the message "No insights available — add sales records to get started."
4. THE Insight_Panel SHALL sort Insight_Cards with `critical` severity first, `warning` second, and `info` last; within the same severity level, cards SHALL be sorted by the magnitude of the deviation (largest deviation first).
5. THE Insight_Panel SHALL display a summary line at the top of the panel stating the total count of `critical` and `warning` insights (e.g. "2 critical · 3 warnings · 4 healthy").
6. THE Insight_Panel SHALL include a timestamp indicating when the insights were last computed (e.g. "Last updated: 14:32:05").
7. WHEN the records array is mutated while the "Insights" tab is active, THE Insight_Panel SHALL re-render with the new insights within 500 ms of the mutation, without a full page reload.
8. THE Insight_Panel SHALL render as a list with `role="list"` on the container element; each Insight_Card SHALL have `role="listitem"` and an `aria-label` composed of its severity, headline, and suggested action (e.g. `aria-label="critical: Revenue dropped — Review sales strategy"`); each Insight_Card SHALL be focusable via the Tab key.
9. WHERE the user is on a viewport narrower than 760 px, THE Insight_Panel SHALL render Insight_Cards in a single-column stack and the "Insights" tab SHALL appear in the mobile bottom tab bar.

---

### Requirement 5: Filter Context Awareness

**User Story:** As a business stakeholder, I want the insights to reflect the same date range and filters I have applied on the Overview tab, so that my analysis stays consistent across the dashboard.

#### Acceptance Criteria

1. WHEN Active_Filters (date range, region, category, or status) are applied on the Overview tab, THE Insight_Engine SHALL recompute insights using only the records that pass those same filters.
2. WHEN no Active_Filters are applied, THE Insight_Engine SHALL compute insights over the full records dataset.
3. WHILE Active_Filters are in effect, THE Insight_Panel SHALL display a notice bar directly above the Insight_Card list stating which filters are active (e.g. "Showing insights for: Region — Jakarta · Last 30 days").
4. WHEN Active_Filters are cleared, THE Insight_Panel SHALL remove the notice bar within 500 ms.
5. WHEN Active_Filters reduce the filtered record count below 5, THE Insight_Engine SHALL display the insufficient-data insight rather than producing potentially misleading insights from a small sample.

---

### Requirement 6: Export and Sharing

**User Story:** As a business stakeholder, I want to export the current insights as a plain-text summary, so that I can paste them into a report or email without taking a screenshot.

#### Acceptance Criteria

1. THE Insight_Panel SHALL render a "Copy summary" button that is visible at all times when the Insights tab is active.
2. WHEN the "Copy summary" button is clicked, THE Dashboard SHALL copy a plain-text representation of all current Insight_Cards to the system clipboard in the same order as they appear in the Insight_Panel (critical first, then warning, then info).
3. THE plain-text summary SHALL include, for each insight: its severity label, headline, explanation, suggested action, and the numeric evidence, each on a new line, separated by a blank line between cards.
4. WHEN the copy operation succeeds, THE Dashboard SHALL display a toast notification with the text "Insights copied to clipboard" that auto-dismisses after 3 seconds.
5. IF the Clipboard API is not available in the user's browser, THEN THE Dashboard SHALL display a toast notification with the text "Copy not supported — select and copy the text manually" that auto-dismisses after 3 seconds, and SHALL render the summary text in a read-only `<textarea>` element within the Insight_Panel.
6. THE Insight_Panel SHALL render a "Download PDF" button that is visible at all times when the Insights tab is active; WHEN clicked, THE Dashboard SHALL trigger the browser's print dialog with a print-optimised stylesheet applied to the Insight_Panel.

---

### Requirement 7: Insight Engine — Determinism and Round-Trip

**User Story:** As a developer, I want the Insight Engine to parse and re-serialise insight results without information loss, so that export and display are always consistent.

#### Acceptance Criteria

1. THE Insight_Engine SHALL represent each computed insight as a plain JavaScript object with the fields: `{ id: string, severity: 'critical'|'warning'|'info', category: string, headline: string, explanation: string, suggestedAction: string, evidence: string, deviation: number }`.
2. THE Insight_Engine SHALL expose a `serialise(insights)` function that converts an array of insight objects to a JSON string.
3. THE Insight_Engine SHALL expose a `deserialise(json)` function that parses a JSON string back into an array of insight objects.
4. THE Insight_Engine `deserialise(serialise(insights))` function SHALL produce an array that is deeply equal to the original `insights` array for any valid insight array conforming to the schema in criterion 1.
5. IF `deserialise` receives a string that is not valid JSON, THEN THE Insight_Engine SHALL throw an `Error` whose message identifies the invalid input and states the expected format (e.g. "deserialise: expected a JSON array of insight objects, received malformed JSON").
6. IF `deserialise` receives valid JSON that is not an array, THEN THE Insight_Engine SHALL throw an `Error` whose message states "deserialise: expected a JSON array, received [type]" where [type] is the actual JSON type of the received value.
