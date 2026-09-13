# MikroTik hotspot integration

The portal deliberately does **not** require access to the billing system backend. It sits in front of the existing voucher flow.

## Network flow

1. The printed QR points to `https://YOUR-PORTAL/q/<campaign-token>`.
2. The portal redirects the phone to the configured local hotspot hostname, for example `http://nexa.spot/login?qr=<token>&qrs=https://YOUR-PORTAL`.
3. `login.html` reads `qr` and `qrs`.
4. The page posts the MikroTik `$(mac)` to the portal claim API.
5. The portal atomically returns one unused voucher.
6. The existing voucher button/handler activates that voucher through the billing system exactly as it does today.

## Walled garden

Before login, allow the portal hostname through the MikroTik Hotspot walled garden. Example:

```routeros
/ip hotspot walled-garden add dst-host=voucher.example.com comment="Voucher QR portal"
```

Use your real portal hostname. If you redirect the portal through another hostname/CDN, allow every hostname required before authentication.

## Patch for the existing `login.html`

The uploaded hotspot already has `#code`, `#voucher-form`, `$(mac)`, `prices.json`, and the current voucher activation handler. Add this block **after jQuery and the existing voucher code are loaded**:

```html
<script>
(function () {
  var params = new URLSearchParams(window.location.search);
  var token = params.get('qr');
  var service = params.get('qrs');
  if (!token || !service) return;

  var mac = '$(mac)';
  if (!mac || mac.indexOf('$(') === 0) return;

  var storageKey = 'voucher-qr-claim-' + token + '-' + mac;
  var started = false;

  function showError(message) {
    if (window.Swal) Swal.fire({ icon: 'error', title: 'QR login failed', text: message });
    else alert(message);
  }

  function start() {
    if (started) return;
    if (!window.jQuery || !window.lnmolink2) return setTimeout(start, 250);
    started = true;

    fetch(service.replace(/\/$/, '') + '/api/public/campaigns/' + encodeURIComponent(token) + '/claim', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
      body: new URLSearchParams({ device_id: mac })
    })
    .then(function (r) { return r.json().then(function (j) { if (!r.ok) throw new Error(j.error || 'Unable to claim voucher'); return j; }); })
    .then(function (data) {
      sessionStorage.setItem(storageKey, data.claim_id || 'claimed');
      jQuery('#code').val(data.voucher);
      jQuery('#voucher-form').trigger('click');
    })
    .catch(function (e) { started = false; showError(e.message || 'Unable to connect automatically.'); });
  }

  start();
})();
</script>
```

This reuses the billing system's current voucher endpoint instead of attempting to replace it.

## Claim safety

Voucher allocation is performed inside an SQLite `BEGIN IMMEDIATE` transaction. A voucher changes from `unused` to `assigned` before it is returned, so simultaneous scans cannot be handed the same code. The same campaign + device key returns the same assignment instead of consuming another voucher on refresh.
