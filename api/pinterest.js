export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const { url } = req.query;
  if (!url) return res.status(400).json({ error: 'No URL provided' });

  const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
  const allImages = new Map(); // url -> true, deduplication

  try {
    // ── Step 1: Fetch the board page (follows pin.it → pinterest.com redirect) ──
    const pageRes = await fetch(url, {
      redirect: 'follow',
      headers: {
        'User-Agent': UA,
        'Accept': 'text/html,application/xhtml+xml,*/*;q=0.9',
        'Accept-Language': 'en-US,en;q=0.9',
        'Cache-Control': 'no-cache',
      },
    });

    let html = '';
    let boardId = null;
    let boardUser = null;
    let boardSlug = null;
    let cookieStr = '';
    let csrfToken = '';

    if (pageRes.ok) {
      // Capture cookies for subsequent API calls
      const setCookieHeaders = pageRes.headers.getSetCookie ? pageRes.headers.getSetCookie() : [];
      const cookieMap = {};
      for (const c of setCookieHeaders) {
        const [pair] = c.split(';');
        const [name, ...rest] = pair.split('=');
        cookieMap[name.trim()] = rest.join('=').trim();
      }
      cookieStr = Object.entries(cookieMap).map(([k, v]) => `${k}=${v}`).join('; ');
      csrfToken = cookieMap['csrftoken'] || '';

      html = await pageRes.text();

      // Extract images from the initial HTML load
      for (const img of extractHtmlImages(html)) allImages.set(img, true);

      // Try to get board ID and board path from HTML
      boardId = extractBoardId(html);

      // Extract board user/slug from the page (needed to call pidgets)
      const pathMatch = html.match(/"board","path":"(\/([^\/\"]+)\/([^\/\"]+)\/)"/) ||
                        html.match(/"path":"(\/([^\/\"]+)\/([^\/\"]+)\/)"[^}]*"type":"board"/);
      if (pathMatch) {
        boardUser = pathMatch[2];
        boardSlug = pathMatch[3];
      }
    }

    // ── Step 2: Always try the pidgets API (public, no auth, 50 pins) ──
    // This is our most reliable source. Extract board user/slug from pin.it if
    // we didn't get them from the HTML.
    if (!boardUser || !boardSlug) {
      // Try to extract from the URL itself if it already looks like a board URL
      const boardUrlMatch = url.match(/pinterest\.com\/([^\/]+)\/([^\/]+)/);
      if (boardUrlMatch) {
        boardUser = boardUrlMatch[1];
        boardSlug = boardUrlMatch[2];
      }
    }

    if (boardUser && boardSlug) {
      const pidgets = await fetchPidgets(boardUser, boardSlug, UA);
      if (pidgets) {
        if (!boardId) boardId = pidgets.boardId;
        for (const img of pidgets.images) allImages.set(img, true);
      }
    }

    if (!boardId) {
      // Couldn't find the board at all
      return res.json({
        images: [...allImages.keys()],
        total: allImages.size,
        pages: 1,
        note: 'board_not_found',
      });
    }

    // ── Step 3: Try Pinterest's internal feed API with session cookies ──
    // This requires a logged-in session; from a server it will 403.
    // We try anyway — it works if somehow the session is valid.
    const API_HEADERS = {
      'User-Agent': UA,
      'Accept': 'application/json, text/javascript, */*; q=0.01',
      'Accept-Language': 'en-US,en;q=0.9',
      'X-Requested-With': 'XMLHttpRequest',
      'X-Pinterest-AppState': 'active',
      'X-CSRFToken': csrfToken,
      'Referer': `https://www.pinterest.com/`,
      'Cookie': cookieStr,
    };

    let bookmark;
    let pageCount = 0;
    const MAX_PAGES = 20;
    let feedApiWorked = false;

    while (pageCount < MAX_PAGES) {
      const feed = await fetchFeedPage(boardId, bookmark, API_HEADERS);
      if (!feed) break;

      const pins = feed.resource_response?.data;
      if (!Array.isArray(pins) || pins.length === 0) break;

      feedApiWorked = true;
      for (const pin of pins) {
        const imgUrl =
          pin?.images?.['564x']?.url ||
          pin?.images?.['474x']?.url ||
          pin?.images?.['236x']?.url ||
          pin?.images?.orig?.url;
        if (imgUrl) allImages.set(imgUrl, true);
      }

      bookmark = feed.resource_response?.bookmark;
      if (!bookmark || bookmark === '-end-') break;
      pageCount++;
    }

    res.json({
      images: [...allImages.keys()],
      total: allImages.size,
      pages: pageCount + 1,
      boardId,
      feedApiWorked,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}

// Fetch up to 50 pins from Pinterest's public widget API (no auth required)
async function fetchPidgets(user, board, ua) {
  try {
    const r = await fetch(
      `https://api.pinterest.com/v3/pidgets/boards/${user}/${board}/pins/?page_size=50`,
      { headers: { 'User-Agent': ua, 'Accept': 'application/json' } }
    );
    if (!r.ok) return null;
    const data = await r.json();
    const pins = data?.data?.pins || [];
    const boardId = data?.data?.board?.id || null;
    const images = pins
      .map(p => {
        // Normalize all sizes to 564x for consistency
        const raw = p?.images?.['564x']?.url || p?.images?.['237x']?.url || p?.images?.['236x']?.url;
        return raw ? raw.replace(/\/\d+x\//, '/564x/') : null;
      })
      .filter(Boolean);
    return { boardId, images };
  } catch {
    return null;
  }
}

// Fetch one page of pins from Pinterest's internal BoardFeedResource API
async function fetchFeedPage(boardId, bookmark, headers) {
  const options = { board_id: boardId, page_size: 100 };
  if (bookmark) options.bookmarks = [bookmark];

  const apiUrl =
    `https://www.pinterest.com/resource/BoardFeedResource/get/` +
    `?data=${encodeURIComponent(JSON.stringify({ options, context: {} }))}` +
    `&_=${Date.now()}`;

  try {
    const res = await fetch(apiUrl, { headers });
    if (!res.ok) return null;
    return res.json();
  } catch {
    return null;
  }
}

// Extract Pinterest CDN image URLs from raw page HTML
function extractHtmlImages(html) {
  const raw =
    html.match(/https:\/\/i\.pinimg\.com\/[0-9]+x\/[^"'\s\\>]+\.(?:jpg|jpeg|png|webp)/g) || [];
  const seen = new Set();
  const imgs = [];
  for (const u of raw) {
    const norm = u.replace(/\/[0-9]+x\//, '/564x/');
    if (!seen.has(norm)) { seen.add(norm); imgs.push(norm); }
  }
  return imgs;
}

// Extract the numeric board ID from the page HTML
function extractBoardId(html) {
  const patterns = [
    /boardfeed:(\d+)/,
    /"board_id"\s*:\s*"(\d+)"/,
    /"boardId"\s*:\s*"(\d+)"/,
    /"board":\{"id":"(\d+)"/,
    /"board_id":"(\d+)"/,
    /"boardId":"(\d+)"/,
    /"entityId":"(\d+)","type":"board"/,
    /data-board-id="(\d+)"/,
    /"id":"(\d{15,})"[^}]*"seo_description"/,
    /"seo_description"[^}]*"id":"(\d{15,})"/,
  ];
  for (const p of patterns) {
    const m = html.match(p);
    if (m) return m[1];
  }
  return null;
}
