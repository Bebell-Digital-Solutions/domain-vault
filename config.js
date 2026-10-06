/* ==========================================================================
   Domain Vault — site configuration
   Shared by the app (app/index.html), the admin panel and downloads.html.
   Everything in this file is public by design: the anon key identifies the
   Supabase project, it does not grant
   access (Row Level Security does that). Never put the service role key, the
   encryption key, or any other secret here.
   ========================================================================== */
window.DOMAIN_VAULT_CONFIG = (function () {
  var isLocal = ['localhost', '127.0.0.1'].indexOf(location.hostname) !== -1;

  var backend = isLocal
    ? {
        supabaseUrl:  'http://127.0.0.1:54321',
        functionsUrl: 'http://127.0.0.1:54321/functions/v1',
        anonKey:      'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0'
      }
    : {
        supabaseUrl:  'https://gqxzawcxuhzcodvuiyzf.supabase.co',
        functionsUrl: 'https://gqxzawcxuhzcodvuiyzf.supabase.co/functions/v1',
        anonKey:      'sb_publishable_uZxk5yuJlIlMxX7whyWWWA_AvTvLZN7'   // publishable key (public by design)
      };

  /* PayPal buttons, created in the PayPal account that receives payments
     (hello.bebelldesignstudio@gmail.com). One per plan:

       buttons          yearly SUBSCRIPTION buttons ("Subscribe")
       lifetimeButtons  one-time "lifetime deal" buttons ("Buy Now"); leave
                        empty until they exist — the app then offers yearly only

     For every button:
       - Item ID (item_number): personal / start-up / business / agency
       - Price and currency: exactly what is set in the admin panel (the
         yearly price for subscriptions, the lifetime price for Buy Now)
       - Return URL: https://app.getdomainvault.com/?payment=success
     Payment notifications (IPN) go to
       https://gqxzawcxuhzcodvuiyzf.supabase.co/functions/v1/billing-webhook
     — set once for the whole PayPal account. A plan whose id is missing or
     still REPLACE_... cannot be bought from the app. */
  backend.paypal = {
    checkoutBase: isLocal
      ? 'https://www.sandbox.paypal.com/cgi-bin/webscr'
      : 'https://www.paypal.com/cgi-bin/webscr',
    buttons: {
      'Personal': 'DL5PLQTBX2HLE',   // USD 29 / year
      'Start-up': 'FMTJ5T5CG7JMA',   // USD 48 / year
      'Business': 'NKCHN2RXPW7U2',   // USD 79 / year
      'Agency':   'DW9CKCY5T86VY'    // USD 98 / year
    },
    lifetimeButtons: {}
  };

  /* Desktop builds, from the GitHub release. `alt` adds a small secondary
     link under the main button — one button cannot serve two architectures.
     A platform with no `url` shows "Coming soon" instead of a dead button.
     Update these when cutting a new desktop-v* release. */
  backend.downloads = {
    macos: {
      url: 'https://github.com/Bebell-Digital-Solutions/domain-vault/releases/download/desktop-v1.0.2/DomainVault-1.0.2-arm64.dmg',
      alt: { label: 'Intel Mac (x64)', url: 'https://github.com/Bebell-Digital-Solutions/domain-vault/releases/download/desktop-v1.0.2/DomainVault-1.0.2-x64.dmg' }
    },
    windows: { url: 'https://github.com/Bebell-Digital-Solutions/domain-vault/releases/download/desktop-v1.0.2/DomainVault-Setup-1.0.2.exe' },
    // The .deb first: it sets up the sandbox rules Ubuntu 24.04+ requires,
    // which an AppImage cannot do for itself.
    linux: {
      url: 'https://github.com/Bebell-Digital-Solutions/domain-vault/releases/download/desktop-v1.0.2/DomainVault-1.0.2-amd64.deb',
      alt: { label: 'other distributions (.AppImage)', url: 'https://github.com/Bebell-Digital-Solutions/domain-vault/releases/download/desktop-v1.0.2/DomainVault-1.0.2-x86_64.AppImage' }
    }
  };

  return backend;
})();
