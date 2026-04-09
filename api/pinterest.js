export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const { url } = req.query;
  if (!url) return res.status(400).json({ error: 'No URL provided' });

  const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

  try {
    // Step 1: Fetch the board page — follows pin.it redirects automatically
    // Capture the Set-Cookie headers so we can use them for API calls
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

    // Step 2: Extract images visible in the initial page HTML
    const allImages = new Map();
    for (const img of extractHtmlImages(html)) allImages.set(img, true);

    // Step 3: Find the board ID
    const boardId = extractBoardId(html);
    if (!boardId) {
      return res.json({ images: [...allImages.keys()], pages: 1, debug: 'no_board_id' });
    }

    // Step 4: Paginate through ALL pins via BoardFeedResource
    // Use the session cookies we captured from the page load
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

    while (pageCount < MAX_PAGES) {
      const feed = await fetchFeedPage(boardId, bookmark, API_HEADERS);
      if (!feed) break;

      const pins = feed.resource_response?.data;
      if (!Array.isArray(pins) || pins.length === 0) break;

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

    res.json({ images: [...allImages.keys()], total: allImages.size, pages: pageCount + 1, boardId });
  } catch (e) {
    res.status(500).json({ error: e.message });
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
