<?php
// =========================================================
// WatchTogether — وسيط TURN على استضافة PHP (cPanel)
// ضع المفتاح في متغيّر بيئة، لا في الكود:
//   SetEnv METERED_APP yourapp
//   SetEnv METERED_KEY xxxxx
//   SetEnv ALLOWED_ORIGIN https://your-site.com
// بيانات العميل: calls.turnFetchUrl = 'https://your-site.com/turn.php'
// =========================================================

header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store');
$origin = getenv('ALLOWED_ORIGIN') ?: '*';
header('Access-Control-Allow-Origin: ' . $origin);
header('Vary: Origin');
header('Access-Control-Allow-Methods: POST, OPTIONS');
header('Access-Control-Allow-Headers: content-type, authorization, apikey, x-client-info');
if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') { http_response_code(204); exit; }
if ($_SERVER['REQUEST_METHOD'] !== 'POST') { http_response_code(405); echo '{"error":"method not allowed"}'; exit; }

$app = getenv('METERED_APP');
$key = getenv('METERED_KEY');
if (!$app || !$key) { http_response_code(500); echo '{"error":"server not configured"}'; exit; }

// كاش 60 ثانية: يقلّل ضغط المزوّد ويُسرّع بدء المكالمات
$cacheFile = sys_get_temp_dir() . '/wt-turn.json';
if (is_file($cacheFile) && (time() - filemtime($cacheFile)) < 60) { readfile($cacheFile); exit; }

$url = 'https://' . rawurlencode($app) . '.metered.live/api/v1/turn/credentials?apiKey=' . rawurlencode($key);
$ch = curl_init($url);
curl_setopt_array($ch, [
  CURLOPT_RETURNTRANSFER => true,
  CURLOPT_TIMEOUT => 4,
  CURLOPT_HTTPHEADER => ['Accept: application/json']
]);
$body = curl_exec($ch);
$code = curl_getinfo($ch, CURLINFO_HTTP_CODE);
curl_close($ch);

if ($code !== 200 || !$body) { http_response_code(502); echo '{"error":"turn provider unreachable"}'; exit; }
// نتحقّق أنه JSON يحتوي urls قبل التخزين في الكاش
$decoded = json_decode($body, true);
if (!is_array($decoded)) { http_response_code(502); echo '{"error":"invalid provider response"}'; exit; }
@file_put_contents($cacheFile, $body, LOCK_EX);
echo $body;
