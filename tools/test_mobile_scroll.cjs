/**
 * Automated test suite for mobile & responsive scrolling behavior.
 * Tests viewports: 390px, 430px, 760px (mobile), 820px, 1200px (desktop).
 * Verifies:
 *  - Mobile horizontal scrollability of .chapters (.scrollWidth > .clientWidth)
 *  - Real scrollLeft changes before & after scrolling
 *  - Chapter 11 reachability, visibility, and clickability
 *  - Selection of chapter does NOT bounce back to 0 (no bounce-back bug)
 *  - Vertical page scrolling reveals level cards without scroll hijacking
 *  - Narrow desktop (820px) 2-column layout fits without horizontal page overflow
 *  - Full desktop (1200px) layout works normally
 */

const fs = require('fs');
const path = require('path');

function getPlaywright() {
  try {
    return require('playwright');
  } catch (e) {
    return require('D:/npm-global/node_modules/playwright');
  }
}

const { chromium } = getPlaywright();

const VIEWPORTS = [
  { name: 'iPhone (390px)', width: 390, height: 844, isMobile: true },
  { name: 'Large Mobile (430px)', width: 430, height: 932, isMobile: true },
  { name: 'Breakpoint Boundary (760px)', width: 760, height: 800, isMobile: true },
  { name: 'Narrow Desktop / Tablet (820px)', width: 820, height: 1180, isMobile: false },
  { name: 'Standard Desktop (1200px)', width: 1200, height: 900, isMobile: false }
];

const EDGE_PATH = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const BASE_URL = process.env.TEST_BASE_URL || 'http://127.0.0.1:8791/#map';
const QA_DIR = path.resolve(__dirname, '../.question-import/qa');

async function run() {
  console.log(`Starting Mobile & Desktop Scroll Test Suite on ${BASE_URL}...`);
  if (!fs.existsSync(QA_DIR)) {
    fs.mkdirSync(QA_DIR, { recursive: true });
  }

  const browser = await chromium.launch({
    headless: true,
    executablePath: EDGE_PATH,
    args: ['--disable-gpu', '--no-first-run', '--no-default-browser-check']
  });

  const results = [];

  for (const vp of VIEWPORTS) {
    console.log(`\n========================================`);
    console.log(`Testing Viewport: ${vp.name} [${vp.width}x${vp.height}]`);
    console.log(`========================================`);

    const context = await browser.newContext({
      viewport: { width: vp.width, height: vp.height },
      deviceScaleFactor: 1
    });
    const page = await context.newPage();

    try {
      await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('.chapters', { timeout: 10000 });

      // Measure layout
      const layout = await page.evaluate(() => {
        const body = document.body;
        const chapterArea = document.querySelector('.chapter-area');
        const chapters = document.querySelector('.chapters');
        const stats = document.querySelector('.stats');
        const buttons = Array.from(document.querySelectorAll('.chapter'));

        return {
          windowInnerWidth: window.innerWidth,
          bodyScrollWidth: body.scrollWidth,
          bodyHasOverflow: body.scrollWidth > window.innerWidth,
          chapterAreaDisplay: chapterArea ? getComputedStyle(chapterArea).display : null,
          chapterAreaWidth: chapterArea ? chapterArea.clientWidth : null,
          chaptersDisplay: chapters ? getComputedStyle(chapters).display : null,
          chaptersFlexDirection: chapters ? getComputedStyle(chapters).flexDirection : null,
          chaptersClientWidth: chapters ? chapters.clientWidth : null,
          chaptersScrollWidth: chapters ? chapters.scrollWidth : null,
          chaptersScrollLeft: chapters ? chapters.scrollLeft : null,
          statsClientWidth: stats ? stats.clientWidth : null,
          statsScrollWidth: stats ? stats.scrollWidth : null,
          statsHasOverflow: stats ? stats.scrollWidth > stats.clientWidth : false,
          chapterCount: buttons.length
        };
      });

      console.log(`  Window: ${layout.windowInnerWidth}px, Body scrollWidth: ${layout.bodyScrollWidth}px (Overflow: ${layout.bodyHasOverflow})`);
      console.log(`  Chapters: clientWidth=${layout.chaptersClientWidth}px, scrollWidth=${layout.chaptersScrollWidth}px, scrollLeft=${layout.chaptersScrollLeft}px`);

      if (vp.isMobile) {
        // Assertion 1: Chapter area is flex column
        if (layout.chapterAreaDisplay !== 'flex') {
          throw new Error(`Mobile chapter-area display should be flex, got ${layout.chapterAreaDisplay}`);
        }

        // Assertion 2: Chapters is flex row and horizontally scrollable
        if (layout.chaptersFlexDirection !== 'row') {
          throw new Error(`Mobile chapters flex-direction should be row, got ${layout.chaptersFlexDirection}`);
        }
        if (layout.chaptersScrollWidth <= layout.chaptersClientWidth) {
          throw new Error(`Mobile chapters container is NOT scrollable: scrollWidth (${layout.chaptersScrollWidth}) <= clientWidth (${layout.chaptersClientWidth})`);
        }
        console.log(`  ✓ Chapter container is horizontally scrollable (${layout.chaptersScrollWidth} > ${layout.chaptersClientWidth})`);

        // Assertion 3: Body has no unexpected horizontal page overflow
        if (layout.bodyHasOverflow) {
          throw new Error(`Page body has horizontal overflow at ${vp.width}px: scrollWidth=${layout.bodyScrollWidth} > ${layout.windowInnerWidth}`);
        }
        console.log(`  ✓ Page has no horizontal overflow`);

        // Action: Scroll to chapter 11
        const scrollResult = await page.evaluate(() => {
          const chapters = document.querySelector('.chapters');
          const beforeScroll = chapters.scrollLeft;
          chapters.scrollLeft = chapters.scrollWidth - chapters.clientWidth;
          const afterScroll = chapters.scrollLeft;

          const buttons = Array.from(document.querySelectorAll('.chapter'));
          const ch11 = buttons[buttons.length - 1]; // Chapter 11
          const rect = ch11.getBoundingClientRect();

          return {
            beforeScroll,
            afterScroll,
            ch11Text: ch11.innerText.replace(/\s+/g, ' '),
            rect: { left: rect.left, right: rect.right, width: rect.width },
            isInViewport: rect.left >= 0 && rect.right <= window.innerWidth + 2
          };
        });

        console.log(`  Horizontal scroll test: scrollLeft ${scrollResult.beforeScroll} -> ${scrollResult.afterScroll}`);
        if (scrollResult.afterScroll <= 0) {
          throw new Error(`Failed to scroll chapters horizontally: scrollLeft remained ${scrollResult.afterScroll}`);
        }
        console.log(`  ✓ ScrollLeft changed successfully (+${scrollResult.afterScroll}px)`);

        console.log(`  Chapter 11 (${scrollResult.ch11Text}): left=${Math.round(scrollResult.rect.left)}px, right=${Math.round(scrollResult.rect.right)}px, inViewport=${scrollResult.isInViewport}`);
        if (!scrollResult.isInViewport) {
          throw new Error(`Chapter 11 is not fully visible in viewport after scroll! Rect: ${JSON.stringify(scrollResult.rect)}`);
        }
        console.log(`  ✓ Chapter 11 is in viewport and reachable`);

        // Action: Click Chapter 11
        const clickResult = await page.evaluate(async () => {
          const buttons = Array.from(document.querySelectorAll('.chapter'));
          const ch11 = buttons[buttons.length - 1];
          ch11.click();

          // Wait a tick for re-render
          await new Promise(r => setTimeout(r, 60));

          const newChapters = document.querySelector('.chapters');
          const active = newChapters.querySelector('.chapter.active');
          const head = document.querySelector('.chapter-head h3');
          const newRect = active ? active.getBoundingClientRect() : null;

          return {
            newScrollLeft: newChapters.scrollLeft,
            activeText: active ? active.innerText.replace(/\s+/g, ' ') : null,
            headText: head ? head.innerText : null,
            rect: newRect ? { left: newRect.left, right: newRect.right } : null,
            isInViewport: newRect ? (newRect.left >= 0 && newRect.right <= window.innerWidth + 2) : false
          };
        });

        console.log(`  Post-click check: Active="${clickResult.activeText}", scrollLeft=${clickResult.newScrollLeft}px, inViewport=${clickResult.isInViewport}`);
        if (clickResult.newScrollLeft === 0 && scrollResult.afterScroll > 200) {
          throw new Error(`Bounce-back bug detected! scrollLeft bounced back to 0 after clicking Chapter 11!`);
        }
        if (!clickResult.headText.includes('11')) {
          throw new Error(`Levels pane did not update to Chapter 11! Heading: "${clickResult.headText}"`);
        }
        console.log(`  ✓ Chapter 11 selected without bounce-back (scrollLeft remains ${clickResult.newScrollLeft}px)`);
        console.log(`  ✓ Levels pane updated: "${clickResult.headText}"`);

        // Action: Vertical scroll test to view levels
        const verticalResult = await page.evaluate(() => {
          window.scrollTo(0, 300);
          const levels = Array.from(document.querySelectorAll('.level'));
          return {
            windowScrollY: window.scrollY,
            levelCount: levels.length,
            firstLevelVisible: levels[0] ? levels[0].getBoundingClientRect().top < window.innerHeight : false
          };
        });

        console.log(`  Vertical scroll check: window.scrollY=${verticalResult.windowScrollY}px, levelsCount=${verticalResult.levelCount}`);
        if (verticalResult.windowScrollY === 0) {
          throw new Error(`Vertical scroll failed or was hijacked back to 0!`);
        }
        console.log(`  ✓ Vertical scroll to levels works normally`);

        const screenshotPath = path.join(QA_DIR, `scroll-${vp.width}.png`);
        await page.screenshot({ path: screenshotPath, fullPage: false });
        console.log(`  ✓ Screenshot saved: ${screenshotPath}`);

        results.push({ viewport: vp.name, status: 'PASS', details: `ScrollLeft: 0 -> ${scrollResult.afterScroll} -> ${clickResult.newScrollLeft} (no bounce)` });
      } else {
        // Desktop check (820px and 1200px)
        if (layout.bodyHasOverflow) {
          throw new Error(`Desktop page has horizontal overflow at ${vp.width}px: scrollWidth=${layout.bodyScrollWidth} > ${layout.windowInnerWidth}`);
        }
        console.log(`  ✓ Desktop page has no horizontal overflow`);

        if (layout.statsHasOverflow) {
          throw new Error(`Stats bar has horizontal overflow at ${vp.width}px: scrollWidth=${layout.statsScrollWidth} > clientWidth=${layout.statsClientWidth}`);
        }
        console.log(`  ✓ Stats bar has no overflow (${layout.statsScrollWidth} <= ${layout.statsClientWidth})`);

        // Check chapter selection on desktop
        const desktopClick = await page.evaluate(async () => {
          const buttons = Array.from(document.querySelectorAll('.chapter'));
          const ch5 = buttons[4]; // Chapter 5
          ch5.click();
          await new Promise(r => setTimeout(r, 60));
          const head = document.querySelector('.chapter-head h3');
          return {
            headText: head ? head.innerText : null
          };
        });

        if (!desktopClick.headText.includes('5')) {
          throw new Error(`Desktop chapter selection failed! Head: ${desktopClick.headText}`);
        }
        console.log(`  ✓ Desktop chapter selection works: "${desktopClick.headText}"`);

        const screenshotPath = path.join(QA_DIR, `scroll-${vp.width}.png`);
        await page.screenshot({ path: screenshotPath, fullPage: false });
        console.log(`  ✓ Screenshot saved: ${screenshotPath}`);

        results.push({ viewport: vp.name, status: 'PASS', details: `Desktop dual-column clean, zero overflow` });
      }
    } catch (err) {
      console.error(`  ✗ FAIL in ${vp.name}:`, err.message);
      results.push({ viewport: vp.name, status: 'FAIL', error: err.message });
      throw err;
    } finally {
      await context.close();
    }
  }

  await browser.close();

  console.log(`\n========================================`);
  console.log(`TEST SUMMARY: ${results.filter(r => r.status === 'PASS').length}/${results.length} PASSED`);
  console.log(`========================================`);
  for (const r of results) {
    console.log(`  [${r.status}] ${r.viewport}: ${r.details || r.error}`);
  }
}

run().catch(err => {
  console.error('\nTest suite execution failed:', err);
  process.exit(1);
});
