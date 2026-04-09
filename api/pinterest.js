export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const { url } = req.query;
  if (!url) return res.status(400).json({ error: 'No URL provided' });

  const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

  try {
    // Step 1: Fetch the board page — follows pin.it redirects automatically
    // Capture the final URL (after redirect) and session cookies
    const pageRes = await fetch(url, {
      redirect: 'follow',
      headers: {
        'User-Agent': UA,
        'Accept': 'text/html,application/xhtml+xml,*/*;q=0.9',
        'Accept-Language': 'en-US,en;q=0.9',
        'Cache-Control': 'no-cache',
      },
    });
    if (!pageRes.ok) return res.status(pageRes.status).json({ error: `Pinterest returned ${pageRes.status}` });

    // Build a cookie string from the response Set-Cookie headers
    const setCookieHeaders = pageRes.headers.getSetCookie ? pageRes.headers.getSetCookie() : [];
    const cookieMap = {};
    for (const c of setCookieHeaders) {
      const [pair] = c.split(';');
      const [name, ...rest] = pair.split('=');
      cookieMap[name.trim()] = rest.join('=').trim();
    }
    const cookieStr = Object.entries(cookieMap).map(([k, v]) => `${k}=${v}`).join('; ');
    const csrfToken = cookieMap['csrftoken'] || '';

    const html = await pageRes.text();
    const htmlLen = html.length;

    // Extract the final board URL from the HTML (after pin.it redirect)
    const boardPathMatch = html.match(/"board","path":"(\/[^\/]+\/[^\/\"]+\/)"/) ||
                           html.match(/"path":"(\/[^\/]+\/[^\/\"]+\/)"[^}]*"type":"board"/);
    const boardPath = boardPathMatch ? boardPathMatch[1] : null;

    // Step 2: Extract images visible in the initial page HTML
    const allImages = new Map();
    for (const img of extractHtmlImages(html)) allImages.set(img, true);

    // Step 3: Find the board ID — try HTML first, then fall back to pidgets API
    let boardId = extractBoardId(html);
    let boardUser = null;
    let boardSlug = null;

    if (!boardId && boardPath) {
      // Extract username/boardname from path like /lebraunz/ceramics/
      const parts = boardPath.split('/').filter(Boolean);
      if (parts.length >= 2) {
        boardUser = parts[0];
        boardSlug = parts[1];
        // Try pidgets API — it returns board.id and doesn't require auth
        const pidgetsData = await fetchPidgets(boardUser, boardSlug, UA);
        if (pidgetsData) {
          boardId = pidgetsData.boardId;
          // Also add the 50 images from pidgets
          for (const img of pidgetsData.images) allImages.set(img, true);
        }
      }
    }

    if (!boardId) {
      return res.json({
        images: [...allImages.keys()],
        pages: 1,
        debug: `no_board_id | html_len=${htmlLen} | board_path=${boardPath}`,
      });
    }

    // Step 4: Paginate through ALL pins via BoardFeedResource
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

    // Step 5: If BoardFeedResource didn't work, try fetching more from pidgets
    // (pidgets caps at 50, but better than nothing)
    if (!feedApiWorked && boardUser && boardSlug) {
      const pidgetsData = await fetchPidgets(boardUser, boardSlug, UA);
      if (pidgetsData) {
        for (const img of pidgetsData.images) allImages.set(img, true);
      }
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

// Fetch pins from Pinterest's public widget API (no auth, max 50 pins)
async function fetchPidgets(user, board, ua) {
  try {
    const r = await fetch(`https://api.pinterest.com/v3/pidgets/boards/${user}/${board}/pins/?page_size=50`, {
      headers: { 'User-Agent': ua, 'Accept': 'application/json' },
    });
    if (!r.ok) return null;
    const data = await r.json();
    const pins = data?.data?.pins || [];
    const boardId = data?.data?.board?.id || null;
    const images = pins
      .map(p => p?.images?.['564x']?.url || p?.images?.['237x']?.url)
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
    // Most reliable: the boardfeed key in the Redux state
    /boardfeed:(\d+)/,
    // Common JSON patterns
    /"board_id"\s*:\s*"(\d+)"/,
    /"boardId"\s*:\s*"(\d+)"/,
    /"board":\{"id":"(\d+)"/,
    /"board_id":"(\d+)"/,
    /"boardId":"(\d+)"/,
    /"entityId":"(\d+)","type":"board"/,
    // Attribute patterns
    /data-board-id="(\d+)"/,
    // Fallback: large numeric ID near seo_description (board metadata)
    /"id":"(\d{15,})"[^}]*"seo_description"/,
    /"seo_description"[^}]*"id":"(\d{15,})"/,
  ];
  for (const p of patterns) {
    const m = html.match(p);
    if (m) return m[1];
  }
  return null;
}
