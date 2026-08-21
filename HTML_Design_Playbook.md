## **📘 HTML Development Playbook: DNN CMS, Mobile, and WCAG 2.1 AA**

A comprehensive guide of design tricks, workarounds, and best practices developed for the Hamilton County Election Commission to ensure perfect rendering across strict CMS environments, mobile devices, print exports, and screen readers.

### **1\. Beating the DNN CMS Constraints**

Enterprise CMS platforms (like DotNetNuke / Evoq) are notorious for stripping code, squashing layouts with global .Normal wrappers, and causing unexpected page reloads.

* **The Sledgehammer Approach (\!important):** DNN aggressively applies global styles. To guarantee your design renders correctly, prefix critical CSS utility classes (like typography, line-heights, and widths) with \!important (e.g., font-size: 24px \!important; or width: 100% \!important;). Use absolute pixel values (px) rather than relative units (rem/em) to prevent the CMS from mathematically shrinking your base fonts.  
* **The \<form\> Wrapper Bug:** DNN wraps the entire page in a giant \<form\> tag. If you create an internal button, it will cause the page to "blink and reload" (submitting the master form).  
  * *Solution:* NEVER use \<form\> tags. Always explicitly define interactive buttons as \<button type="button"\> or use \<a\> tags.  
* **Surviving Script Strippers:** CMS text editors aggressively delete \<script\> blocks upon saving.  
  * *Winning Solution:* Use **Inline JavaScript Event Handlers**. CMS editors treat inline attributes like standard HTML text. Use onclick, onfocusout, and onkeydown directly on HTML elements to build interactive components that survive the CMS and remain fully accessible.  
* **Absolute vs. Relative URLs:** CMS environments often break relative paths (e.g., /Portals/12/...). Always hardcode absolute paths (https://elect.hamiltontn.gov/...) and URL-encode file names (replacing spaces with %20) to prevent broken links. Preserve specific CMS tracking links (like LinkClick.aspx).  
* **Character Encoding (Garble-Free Emojis & Symbols):** CMS platforms often serve pages or parse fragments in legacy single-byte encodings (Windows-1252 / ISO-8859-1), which turns multi-byte UTF-8 emojis or legal symbols (like ✉, 🖨, ⏳, ✅, ❌, ⚠️, or §) into broken text or weird characters (mojibake). 
  * *Solution:* **NEVER** write raw Unicode emojis or special characters inside HTML markup or JavaScript strings. Always use strict ASCII-safe HTML numeric entities (e.g., `&#x2709;&#xFE0F;` for envelopes, `&#x1F5A8;&#xFE0F;` for printers, `&#x26A0;&#xFE0F;` for warning symbols, and `&sect;` for section signs). This makes files 100% pure ASCII, guaranteeing they display correctly under any CMS or server encoding configuration.

### **2\. WCAG 2.1 AA Accessibility Standards**

All code must be optimized for screen readers and visually impaired users to ensure every voter has equal access to information.

* **Screen Reader Sequencing (SC 1.3.2):** When building lists that mimic a physical ballot, do not use CSS grids or column-count to flow the text. You must use **Physical HTML Columns** (e.g., separating the DOM into \<div class="col-1"\> and \<div class="col-2"\>). This mathematically guarantees that a screen reader reads entirely down the first column before wrapping to the top of the second.  
* **Shielding Decorative Elements:** Emojis and visual icons (e.g., 🗳️, 🇺🇸, checkmarks) create a terrible, cluttered audio experience for screen readers. Always wrap them in \<span aria-hidden="true"\>emoji\</span\> so they are bypassed.  
* **Disambiguating Buttons:** If multiple buttons share the same visual text (e.g., "Add to Calendar"), inject unique aria-label attributes (e.g., aria-label="Add May Election deadline to calendar") so screen readers know exactly what the button does. Always include target="\_blank" and rel="noopener noreferrer" for external links, and warn users in the aria-label that the link opens a new tab.  
* **Interactive State Toggling (SC 4.1.2):** Screen readers need to know if a dropdown menu is open or closed. Interactive buttons must dynamically toggle aria-expanded="true" and aria-expanded="false" using inline JavaScript.  
* **Keyboard Navigation (SC 1.4.13):** Users must be able to dismiss revealed content without moving their mouse. Dropdown menus must include an onkeydown event that listens for the **Escape key** to close the menu and return focus to the toggle button.  
* **Contrast Ratios:** Ensure a minimum contrast ratio of 4.5:1. Stick to high-contrast palettes (e.g., dark navy \#1e3a8a on light gray \#f8fafc).

### **3\. Mobile Responsiveness & Fluid Layouts**

Avoid fixed widths and complex media queries where possible by utilizing modern flexbox and grid algorithms.

* **Fluid Flexbox Wrapping:** Use display: flex; flex-wrap: wrap; gap: 24px; alongside flexible bases (e.g., flex: 1 1 300px;). This allows cards to sit side-by-side on desktop monitors but cleanly snap into a single, scrollable column on smartphones.  
* **CSS Grid Orphan Alignment:** When using strict CSS Grids, an odd number of items can leave a single card stretched across the bottom or stranded in the left column. Use the last-of-type:nth-of-type(odd) selector trick to gracefully push orphaned grid items into the center or the second column.  
* **Advanced Text Wrapping & Orphans:** \* Use white-space: nowrap \!important; to mathematically glue dates, times, and key phrases together (e.g., "April 30", "12:00 PM", "Vote Ready") so they don't awkwardly split across lines.  
  * Use hidden non-breaking spaces ( ) to tie the last few words of a sentence together.  
  * For blockquotes and mission statements, utilize text-wrap: balance; to evenly distribute text across lines dynamically.  
* **Touch Targets:** Ensure interactive buttons have generous padding (e.g., padding: 16px 24px;) and span 100% width on mobile to create large, easy-to-tap zones for thumbs.  
* **Table Scrolling:** For data-heavy tables, always wrap the \<table\> in a \<div\> with overflow-x: auto; to prevent them from breaking page boundaries on mobile screens.

### **4\. Perfecting Print & PDF Generation**

Browsers handle printing web pages poorly, often cutting columns in half or dropping backgrounds. Newspapers also have strict legibility minimums.

* **The Chrome Column Bug:** Chrome completely fails to calculate page breaks inside multi-column (column-count) layouts.  
  * *Solution:* For print views, strip out column-count and replace it with **explicit physical column wrappers** inside a flex row. This mathematically forces elements to stack top-to-bottom without spilling into invisible 3rd or 4th pages.  
* **Absolute Bounding Boxes:** To guarantee a design fits perfectly onto a standard letter page, use @media print to enforce an absolute bounding box (e.g., height: 9.8in \!important; overflow: hidden \!important;). This gives the browser a strict margin of safety.  
* **Newspaper Ad Minimums:** Newspaper publishers (like the Times Free Press) require political ad copy to be a minimum of 10pt or 12pt. In CSS, 10pt is roughly 13.3px. To guarantee compliance when exporting HTML to PDF for print advertising, explicitly set the absolute minimum font size on the page to **14px** (or larger).  
* **Forcing Background Colors:** Browsers strip background colors to save ink. Always include \-webkit-print-color-adjust: exact \!important; and print-color-adjust: exact \!important; in the @media print body styles so high-contrast headers and shaded rows render accurately.  
* **Preventing Element Splits:** Use break-inside: avoid \!important; and page-break-inside: avoid \!important; on contest boxes or info cards to stop the printer from slicing them in half across two pages.
* **Frictionless Print Form Cloning & Value Synchronization:** When creating a button to print an interactive form, standard `cloneNode(true)` fails to serialize properties into `.innerHTML` and leaves messy default placeholders. Use these tricks inside your print compiling scripts:
  * *Option Selection Serialization:* Cloned select dropdowns do not preserve selected values in `innerHTML`. You must loop through cloned select elements and explicitly set the attribute `selected="selected"` on the active option of each cloned element.
  * *Hiding "No Filter" Defaults:* If a select dropdown is left on its default "No Filter" value (e.g., value is "None" or "All"), dynamically clear the cloned option's text content to `""` so it prints as a clean, blank underline.
  * *Empty Date Bypassing:* Chrome and other browsers print empty date inputs displaying `"mm/dd/yyyy"`. If a date input is empty in the original form, change its cloned type from `"date"` to `"text"` so it prints as a completely clean blank line.
  * *Stripping Placeholders:* Strip the `placeholder` attribute entirely from all cloned inputs to prevent instructions (e.g. signature guidelines like "Type or sign...") from cluttering the printed copy.
  * *Print Validation Bypass:* Always bypass required-field validation checks when clicking the print button, allowing users to print empty or partially filled forms to complete by hand, while keeping validation strictly enforced for digital submissions.

### **5\. Universal "Add to Calendar" Functionality**

Mobile browsers aggressively block automated file downloads (like raw .ics files) via JavaScript.

* **The 3-Tier Fallback Strategy:** To ensure calendar links work frictionlessly across all devices:  
  * **Google Calendar:** Provide a direct URL link (calendar.google.com/calendar/render?action=TEMPLATE...). This opens directly in the native Android app or web browser.  
  * **Outlook:** Provide a direct Outlook deep link (outlook.live.com/calendar/0/deeplink/compose...).  
  * **Apple / ICS:** Use a data:text/calendar;charset=utf-8,BEGIN:VCALENDAR... URI with a download attribute. iOS natively intercepts this URI and pops up the "Add Event" screen.  
* **RFC 5545 Compliance:** When generating .ics payloads, you must include UID and DTSTAMP fields, or enterprise calendars (like Outlook desktop) will reject the file.  
* **Timezones:** Never use bare times (e.g., 120000). Always use UTC (Z) or explicitly define the timezone (DTSTART;TZID=America/New\_York:20260219T120000).

### **6\. Universal Map and Location Links**

To ensure a frictionless experience for voters trying to find polling places, offices, or satellite locations, never leave physical addresses as plain text.

* **The Universal Search URL:** Always convert addresses into clickable `<a>` links using the universal Google Maps search query format (e.g., `https://maps.google.com/?q=700+River+Terminal+Road,+Chattanooga,+TN+37406`).  
* **Native App Hand-off:** This specific URL structure is highly recommended because it is designed to automatically launch the native Google Maps or Apple Maps application when tapped on a mobile device.  
* **Desktop Fallback:** If the user clicks the link on a desktop computer, it falls back seamlessly to the standard Google Maps website in their browser.  
* **Best Practice:** Ensure these links always include `target="_blank"` and `rel="noopener noreferrer"` so the map opens in a new tab without forcing the voter away from the Election Commission website. Always pair the link with a subtle hover state (like `text-decoration: underline`) to indicate interactivity.

### **7\. Interactive Lists, Data Tables, & CSV Exports**

When presenting directory lists, polling place lists, candidate lists, or other tabular election data, always provide an interactive CSV export feature:
* **The "Export CSV" Button:** Position a visible, accessible button labeled `Export CSV` (optionally styled with high-contrast themes and a shielded download icon, e.g. `&#x1F4E5;`) near search filters or table headers.
* **Search/Filter Synchronization:** The export mechanism must dynamically respect any client-side search query or active filter. If the user has typed a query (e.g. searching for a specific precinct or neighborhood), clicking "Export CSV" should generate a CSV file containing only those matching/filtered records. If no filters are active, it falls back to exporting the entire data set.
* **CSV Formatting & Escaping:** Ensure all cell values containing double quotes or commas are safely wrapped in double quotes. Double quotes inside the values must be escaped by doubling them (e.g., `value.replace(/"/g, '""')`).
* **Frictionless Download:** Use a client-side `Blob` and `URL.createObjectURL` payload to initiate a direct file download without requiring server-side roundtrips or third-party libraries.


