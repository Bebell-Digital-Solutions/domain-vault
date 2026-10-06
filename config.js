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

  /* PayPal "Buy Now" buttons, one per pack, created in the PayPal account
     that receives payments. For each button set:
       - Item ID (item_number): startup / business / agency
       - Price and currency: exactly what is set in the admin panel
       - Return URL: https://app.getdomainvault.com/?payment=success
       - Notification URL (IPN):
           https://gqxzawcxuhzcodvuiyzf.supabase.co/functions/v1/billing-webhook
     Then paste each button's hosted_button_id below. A pack whose id is
     still REPLACE_... cannot be bought from the site. */
  backend.paypal = {
    checkoutBase: isLocal
      ? 'https://www.sandbox.paypal.com/cgi-bin/webscr'
      : 'https://www.paypal.com/cgi-bin/webscr',
    buttons: {
      'Personal': 'REPLACE_STARTUP_BUTTON_ID',
      'Start-up': 'REPLACE_STARTUP_BUTTON_ID',
      'Business': 'REPLACE_BUSINESS_BUTTON_ID',
      'Agency':   'REPLACE_AGENCY_BUTTON_ID'
    }
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
