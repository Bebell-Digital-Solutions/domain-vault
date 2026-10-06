
        /* ==========================================================================
           JAVASCRIPT LOGIC
           ========================================================================== */


        const PLAN_LIMITS = {
            'Free': 0,
            'Personal': 5,
            'Start-up': 20,
            'Business': 50,
            'Agency': Infinity
        };

        // --- PAYMENT CONFIGURATION ---
        // PayPal only. Each plan is a yearly subscription; a one-time
        // "lifetime deal" is offered only where both a lifetime price and a
        // lifetime button exist. Button ids live in config.js; prices live in
        // the database and are edited from the admin panel.
        const PAYPAL = (window.DOMAIN_VAULT_CONFIG && window.DOMAIN_VAULT_CONFIG.paypal) || { buttons: {} };
        let packPrices = {};   // plan -> { amount, lifetimeAmount, currency }, loaded from the API
        const PLAN_RANK = { 'Free': -1, 'Personal': 0, 'Start-up': 1, 'Business': 2, 'Agency': 3 };
        const PAYPAL_MANAGE_URL = 'https://www.paypal.com/myaccount/autopay/';

        /** Domain limit for a plan; unknown plans get the Personal limit. */
        function planLimit(plan) {
            return Object.prototype.hasOwnProperty.call(PLAN_LIMITS, plan) ? PLAN_LIMITS[plan] : PLAN_LIMITS.Personal;
        }

        /** "Business", "business", "start-up", "startup" → the plan's proper name, or null. */
        function canonicalPlan(value) {
            const key = String(value || '').toLowerCase().replace(/[\s_-]/g, '');
            return Object.keys(PLAN_RANK).find(p => p.toLowerCase().replace(/[\s_-]/g, '') === key) || null;
        }

        function buttonId(plan, mode) {
            const id = ((mode === 'lifetime' ? PAYPAL.lifetimeButtons : PAYPAL.buttons) || {})[plan];
            return id && id.indexOf('REPLACE_') !== 0 ? id : null;
        }

        function billingMode() {
            const checked = document.querySelector('input[name="upgradeBilling"]:checked');
            return checked && checked.value === 'lifetime' ? 'lifetime' : 'yearly';
        }

        function paypalCheckoutUrl(plan, mode) {
            const id = buttonId(plan, mode);
            const price = packPrices[plan];
            const amount = price && (mode === 'lifetime' ? price.lifetimeAmount : price.amount);
            if (!id || amount === null || amount === undefined) return null;
            // custom carries the account email: it is how the payment webhook
            // knows which account the subscription or purchase is for.
            return `${PAYPAL.checkoutBase}?cmd=_s-xclick&hosted_button_id=${encodeURIComponent(id)}`
                + `&custom=${encodeURIComponent(currentUser.email)}`;
        }

        function openUpgrade(preferredPlan) {
            document.getElementById('upgradeCurrentPlan').textContent = currentUser?.plan || 'Personal';
            document.getElementById('upgradeModal').style.display = 'flex';
            loadPackPrices(preferredPlan);
        }

        async function loadPackPrices(preferredPlan) {
            try {
                const res = await apiCall('getPrices', {});
                packPrices = {};
                (res.prices || []).forEach(p => { packPrices[p.plan] = p; });
            } catch (e) { /* the modal falls back to "not available" */ }

            // Offer the lifetime choice only when at least one plan can
            // actually be bought that way.
            const lifetimeOffered = Object.keys(PLAN_RANK).some(p =>
                buttonId(p, 'lifetime') && packPrices[p] && packPrices[p].lifetimeAmount !== null && packPrices[p].lifetimeAmount !== undefined);
            document.getElementById('upgradeBillingGroup').style.display = lifetimeOffered ? '' : 'none';
            if (!lifetimeOffered) document.querySelector('input[name="upgradeBilling"][value="yearly"]').checked = true;
            const mode = billingMode();
            const t = translations[settings.language] || translations.en;

            const select = document.getElementById('upgradePlanSelect');
            Array.from(select.options).forEach(opt => {
                if (!opt.dataset.label) opt.dataset.label = opt.textContent;
                const price = packPrices[opt.value];
                const amount = price && (mode === 'lifetime' ? price.lifetimeAmount : price.amount);
                const priced = amount !== null && amount !== undefined && (mode === 'yearly' || buttonId(opt.value, 'lifetime'));
                // Buying a plan the account already has (or exceeds) would charge for nothing.
                const current = currentUser && currentUser.plan;
                const included = (PLAN_RANK[opt.value] ?? 0) <= (PLAN_RANK[current] ?? 0);
                opt.textContent = included
                    ? `${opt.dataset.label} — included in your plan`
                    : priced
                        ? `${opt.dataset.label} — ${Number(amount).toFixed(2)} ${price.currency}${mode === 'yearly' ? ' / year' : ' once'}`
                        : `${opt.dataset.label} — not available yet`;
                opt.disabled = included || !priced;
            });
            const wanted = preferredPlan && Array.from(select.options).find(o => o.value === preferredPlan && !o.disabled);
            const firstEnabled = Array.from(select.options).find(o => !o.disabled);
            if (wanted) select.value = wanted.value;
            else if (firstEnabled && select.selectedOptions[0] && select.selectedOptions[0].disabled) select.value = firstEnabled.value;

            document.getElementById('proceedToCheckoutBtn').textContent = mode === 'lifetime' ? t.payOnce : t.subscribe;
            document.getElementById('upgradeDescText').textContent = mode === 'lifetime' ? t.lifetimeDesc : t.upgradeDesc;
        }

        // --- TRANSLATION DATA ---
        const translations = {
            en: {
                domainManager: "Domain Vault", brandName: "DOMAIN VAULT", brandSlogan: "Secure Domain Manager",
                dashboard: "Dashboard", allDomains: "All Domains", domainProviders: "Domain Providers", toolsResources: "Tools & Resources",
                calendar: "Calendar", notifications: "Notifications", settings: "Settings", downloads: "Downloads", searchPlaceholder: "Search domains...",
                dashboardOverview: "Dashboard Overview", addNewDomain: "Add New Domain", totalDomains: "Total Domains",
                annualCost: "Annual Cost", expiringSoon: "Expiring Soon", renewalCostsByMonth: "Renewal Costs by Month",
                providersDistribution: "Providers Distribution", domainName: "Domain Name", provider: "Provider",
                renewalDate: "Renewal Date", price: "Price", status: "Status", actions: "Actions", addNewProvider: "Add New Provider",
                userProfile: "User Profile", profilePicture: "Profile Picture", changePicture: "Change Picture", remove: "Remove",
                username: "Username", enterYourName: "Enter your name", saveProfile: "Save Profile", appearance: "Appearance",
                themeColor: "Theme Accent Color", customColor: "Custom Accent Color", footer: "Powered with 🧡 by Bebell Digital Solutions",
                addDomain: "Add Domain", editDomain: "Edit Domain", selectProvider: "Select Provider", otherProviderName: "Other Provider Name",
                specifyProvider: "Specify provider", purchaseDate: "Purchase Date", purchasePrice: "Purchase Price", annualRenewalPrice: "Renewal Price",
                providerName: "Provider Name", homepageUrl: "Provider Homepage URL", emailUsername: "Email / Username", password: "Password",
                userIdOptional: "User ID (optional)", autoRenewalOn: "Automatic Renewal is On", addProvider: "Add Provider",
                editProvider: "Edit Provider", providerCredentials: "Provider Credentials", userId: "User ID", domainsRegistered: "Domains Registered",
                autoRenewal: "Auto Renewal", on: "On", off: "Off", openPage: "Website", viewCredentials: "Credentials", statusActive: "Active",
                statusExpiringIn: "Expiring in {days}d", statusExpired: "Expired", noDomainsFound: "No domains found.", noNotifications: "No notifications right now.",
                totalInvestment: "Total Investment", syncAllGCal: "Sync to Google", downloadAllIcs: "Download (.ics)",
                dayNames: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"], urgentRenewals: "Top 5 Urgent Renewals", daysLeft: "Days Left",
                dnsRecords: "DNS Records", recordType: "Type", recordValue: "Value", autoFillWhois: "Auto-fill using WHOIS", fetching: "Fetching live records...",
                noDnsFound: "No DNS records found.", whoisSuccess: "Data loaded from WHOIS!", whoisError: "Could not fetch WHOIS data.",
                toolsDesc: "Explore our curated list of tools to help you manage your domains, check DNS records, and improve your online infrastructure.",
                recommendedProviders: "Recommended Providers", getDeal: "Get Deal", visitTool: "Visit Tool", recommendations: "Recommendations",
                searchRecommendations: "Search hosting, email...", quickDnsCheck: "Quick DNS Check", enterDomainName: "Enter domain name...", checkDns: "Check DNS", others: "Others", other: "Other",
                upgradeTitle: "Upgrade Required", upgradeDesc: "Yearly subscription through PayPal. It renews automatically; cancel any time and keep your plan until the end of the year you paid for.",
                lifetimeDesc: "One payment through PayPal, no renewals: the plan is yours for good.", subscribe: "Subscribe with PayPal", payOnce: "Pay once with PayPal",
                billing: "Billing", yearly: "Yearly", lifetime: "Lifetime (one payment)", manageSubscription: "Manage or cancel your subscription in PayPal", contactAdmin: "Contact Admin to Upgrade", maybeLater: "Maybe Later",
                reports: "Reports", applyFilter: "Apply Filter", emailReport: "Email Report", downloadCsv: "Download CSV", startDate: "Start Date", endDate: "End Date",
                currentPlan: "Your Current Plan:", selectNewPlan: "Select New Plan",
                reminderSettings: "Renewal Reminders", reminderSettingsHelp: "We remind you before a domain expires, so nothing lapses by accident.",
                reminderEnabled: "Send me renewal reminders", reminderChannels: "How", reminderWhen: "When", reminderOnTheDay: "on the day", saveReminders: "Save Reminders",
                passwordOptionalHint: "Optional. Stored encrypted; only you can reveal it.", removeStoredPassword: "Delete the stored password",
                revealNote: "Each reveal is logged, up to 10 per hour.",
                calendarFeedTitle: "Subscribe to your renewals", calendarFeedLink: "Private calendar link",
                calendarFeedIntro: "Add this private link to Google Calendar, Apple Calendar or Outlook. Every renewal date appears there and stays current as you add, edit or renew domains.",
                calendarFeedPrivate: "Anyone with this link can see your domain names and renewal dates. Keep it private.",
                addToGoogle: "Add to Google Calendar", openInCalendarApp: "Open in Apple Calendar / Outlook", resetFeedLink: "Reset link",
                calendarFeedDelay: "Calendar apps refresh subscriptions on their own schedule (Google: every few hours), so a change can take a while to show up.",
                security: "Security", currentPassword: "Current password", newPassword: "New password", passwordRule: "At least 10 characters.",
                confirmPassword: "Confirm new password", changePassword: "Change Password",
                yourData: "Your Data", yourDataHelp: "Download everything in your vault. Stored registrar passwords are never included.",
                exportCsv: "Export CSV", exportJson: "Export JSON", purchases: "Billing", noPurchases: "No subscriptions or purchases yet."
            },
            es: {
                domainManager: "Domain Vault", brandName: "DOMAIN VAULT", brandSlogan: "Gestor Seguro de Dominios",
                dashboard: "Tablero", allDomains: "Todos los Dominios", domainProviders: "Proveedores", toolsResources: "Herramientas",
                calendar: "Calendario", notifications: "Notificaciones", settings: "Configuración", downloads: "Descargas", searchPlaceholder: "Buscar dominios...",
                dashboardOverview: "Resumen del Tablero", addNewDomain: "Añadir Dominio", totalDomains: "Dominios Totales",
                annualCost: "Costo Anual", expiringSoon: "Próximos a Vencer", renewalCostsByMonth: "Costos de Renovación por Mes",
                providersDistribution: "Distribución de Proveedores", domainName: "Nombre de Dominio", provider: "Proveedor",
                renewalDate: "Fecha de Renovación", price: "Precio", status: "Estado", actions: "Acciones", addNewProvider: "Añadir Proveedor",
                userProfile: "Perfil de Usuario", profilePicture: "Foto de Perfil", changePicture: "Cambiar Foto", remove: "Eliminar",
                username: "Nombre de usuario", enterYourName: "Introduce tu nombre", saveProfile: "Guardar Perfil", appearance: "Apariencia",
                themeColor: "Color de Acento", customColor: "Color Personalizado", footer: "Desarrollado con 🧡 por Bebell Digital Solutions",
                addDomain: "Guardar Dominio", editDomain: "Editar Dominio", selectProvider: "Seleccionar Proveedor", otherProviderName: "Nombre de Otro Proveedor",
                specifyProvider: "Especificar proveedor", purchaseDate: "Fecha de Compra", purchasePrice: "Precio de Compra", annualRenewalPrice: "Precio de Renovación",
                providerName: "Nombre del Proveedor", homepageUrl: "URL de la Página", emailUsername: "Correo / Usuario", password: "Contraseña",
                userIdOptional: "ID de Usuario (opcional)", autoRenewalOn: "Renovación Automática Activada", addProvider: "Guardar Proveedor",
                editProvider: "Editar Proveedor", providerCredentials: "Credenciales", userId: "ID de Usuario", domainsRegistered: "Dominios Registrados",
                autoRenewal: "Renovación Automática", on: "Activado", off: "Desactivado", openPage: "Sitio Web", viewCredentials: "Credenciales", statusActive: "Activo",
                statusExpiringIn: "Vence en {days}d", statusExpired: "Vencido", noDomainsFound: "No se encontraron dominios.", noNotifications: "No hay notificaciones en este momento.",
                totalInvestment: "Inversión Total", syncAllGCal: "Sincronizar a Google", downloadAllIcs: "Descargar (.ics)",
                dayNames: ["Dom", "Lun", "Mar", "Mié", "Jue", "Vie", "Sáb"], urgentRenewals: "Top 5 Próximas Renovaciones", daysLeft: "Días Restantes",
                dnsRecords: "Registros DNS", recordType: "Tipo", recordValue: "Valor", autoFillWhois: "Autocompletar usando WHOIS", fetching: "Obteniendo registros...",
                noDnsFound: "No se encontraron registros DNS.", whoisSuccess: "¡Datos cargados vía WHOIS!", whoisError: "No se pudo obtener datos WHOIS.",
                toolsDesc: "Explora nuestra lista seleccionada de herramientas para ayudarte a gestionar tus dominios y verificar registros DNS.",
                recommendedProviders: "Proveedores Recomendados", getDeal: "Obtener Oferta", visitTool: "Visitar Herramienta", recommendations: "Recomendaciones",
                searchRecommendations: "Buscar hosting, correo...", quickDnsCheck: "Comprobación Rápida DNS", enterDomainName: "Ingrese nombre de dominio...", checkDns: "Comprobar DNS", others: "Otros", other: "Otro",
                upgradeTitle: "Actualización Requerida", upgradeDesc: "Suscripción anual con PayPal. Se renueva automáticamente; cancela cuando quieras y conserva tu plan hasta el final del año pagado.",
                lifetimeDesc: "Un solo pago con PayPal, sin renovaciones: el plan es tuyo para siempre.", subscribe: "Suscribirse con PayPal", payOnce: "Pagar una vez con PayPal",
                billing: "Facturación", yearly: "Anual", lifetime: "De por vida (un pago)", manageSubscription: "Administra o cancela tu suscripción en PayPal", contactAdmin: "Contactar Admin para Actualizar", maybeLater: "Quizás Más Tarde",
                reports: "Reportes", applyFilter: "Aplicar Filtro", emailReport: "Enviar por Correo", downloadCsv: "Descargar CSV", startDate: "Fecha de Inicio", endDate: "Fecha de Fin",
                currentPlan: "Tu Plan Actual:", selectNewPlan: "Seleccionar Nuevo Plan",
                reminderSettings: "Recordatorios de Renovación", reminderSettingsHelp: "Te avisamos antes de que venza un dominio, para que nada caduque por descuido.",
                reminderEnabled: "Enviarme recordatorios de renovación", reminderChannels: "Cómo", reminderWhen: "Cuándo", reminderOnTheDay: "el mismo día", saveReminders: "Guardar Recordatorios",
                passwordOptionalHint: "Opcional. Se guarda cifrada; solo tú puedes verla.", removeStoredPassword: "Eliminar la contraseña guardada",
                revealNote: "Cada consulta queda registrada, hasta 10 por hora.",
                calendarFeedTitle: "Suscríbete a tus renovaciones", calendarFeedLink: "Enlace privado del calendario",
                calendarFeedIntro: "Agrega este enlace privado a Google Calendar, Apple Calendar u Outlook. Todas las fechas de renovación aparecen allí y se mantienen al día cuando agregas, editas o renuevas dominios.",
                calendarFeedPrivate: "Cualquiera con este enlace puede ver tus dominios y sus fechas de renovación. Mantenlo en privado.",
                addToGoogle: "Agregar a Google Calendar", openInCalendarApp: "Abrir en Apple Calendar / Outlook", resetFeedLink: "Restablecer enlace",
                calendarFeedDelay: "Las aplicaciones de calendario actualizan las suscripciones a su propio ritmo (Google: cada pocas horas), así que un cambio puede tardar en aparecer.",
                security: "Seguridad", currentPassword: "Contraseña actual", newPassword: "Nueva contraseña", passwordRule: "Al menos 10 caracteres.",
                confirmPassword: "Confirmar nueva contraseña", changePassword: "Cambiar Contraseña",
                yourData: "Tus Datos", yourDataHelp: "Descarga todo lo que hay en tu bóveda. Las contraseñas de registradores guardadas nunca se incluyen.",
                exportCsv: "Exportar CSV", exportJson: "Exportar JSON", purchases: "Facturación", noPurchases: "Aún no hay suscripciones ni compras."
            }
        };

        // --- DATA ARRAYS FOR TOOLS & RECOMMENDATIONS ---
        const recommendedProvidersData = [
            { name: "Namecheap", desc: "Best for budget domains", rating: 5, url: "https://namecheap.com/", icon: "tag", tags: ["domains"] },
            { name: "Porkbun", desc: "Great UI & pricing", rating: 5, url: "https://porkbun.com/", icon: "piggy-bank", tags: ["domains"] },
            { name: "Hostinger", desc: "Domain + Hosting bundles", rating: 4.5, url: "https://hostinger.com/", icon: "server", tags: ["domains", "hosting"] },
            { name: "IONOS", desc: "Domain registration", rating: 4.3, url: "https://ionos.com/domains/", icon: "globe", tags: ["domains"] },
            { name: "Cloudflare", desc: "Cheapest renewals, at-cost", rating: 4.8, url: "https://www.cloudflare.com/products/registrar/", icon: "globe", tags: ["domains", "cheap-renewal"] },
            { name: "GoDaddy", desc: "Biggest TLD catalog, costly renewals", rating: 3.9, url: "https://www.godaddy.com/domains", icon: "globe", tags: ["domains", "premium-renewal"] }
        ];
        const expandedRecommendationsData = [
            ...recommendedProvidersData,
            { name: "Google Workspace", desc: "Professional email & collaboration.", rating: 5, url: "https://workspace.google.com/", icon: "mail", tags: ["email"] },
            { name: "ProtonMail", desc: "Privacy-focused secure email.", rating: 4.5, url: "https://proton.me/mail", icon: "shield", tags: ["email"] },
            { name: "DigitalOcean", desc: "Developer-friendly cloud hosting.", rating: 4.5, url: "https://digitalocean.com/", icon: "cloud", tags: ["hosting"] },
            { name: "Vercel", desc: "Simple scalable deployment for frontend apps.", rating: 5, url: "https://vercel.com/", icon: "triangle", tags: ["hosting"] }
        ];
        const toolsData = [
            { name: "MXToolbox", desc: "Comprehensive DNS & Email diagnostics", rating: 5, url: "https://mxtoolbox.com", icon: "mail-search", tags: ["dns", "email"] },
            { name: "DNSChecker", desc: "Global DNS propagation check", rating: 5, url: "https://dnschecker.org", icon: "globe-2", tags: ["dns"] },
            { name: "Whois.com", desc: "Domain lookup & registration info", rating: 4, url: "https://whois.com", icon: "search", tags: ["domains"] },
            { name: "Cloudflare", desc: "Free DNS management & fast CDN", rating: 5, url: "https://cloudflare.com", icon: "cloud-lightning", tags: ["dns", "hosting"] },
            { name: "ICANN Lookup", desc: "Official domain registration data", rating: 4.5, url: "https://lookup.icann.org/", icon: "building-2", tags: ["domains"] },
            { name: "SSL Checker", desc: "Verify SSL certificate installation", rating: 4.5, url: "https://www.sslshopper.com/ssl-checker.html", icon: "shield-check", tags: ["ssl"] }
        ];

        // --- APP STATE ---
        let currentUser = null;
        let domains = [];
        let providers = [];
        let notifications = [];
        let settings = { username: 'User', language: 'en', theme: 'orange', reminders: { enabled: true, channels: ['email'], leadDays: [30, 7, 1, 0] } };
        let expensesChart = null;
        let isLoginMode = true;
        let currentCalendarDate = new Date();
        let currentToolFilter = 'all';
        let currentReportData = [];
        let purchases = [];
        let subscriptions = [];
        let pendingPlanChoice = null;   // ?plan=… from the homepage's pricing table
        let authMode = 'login';          // login | register | forgot | recover
        let recoveryToken = null;        // from a password-reset link; kept out of the URL
        let revealedPassword = null;     // credentials modal only, forgotten when it closes
        let credentialsProviderId = null;
        // saveDomains/saveProviders replace the whole list on the server, so
        // nothing may be saved until the real list has been loaded: saving
        // from an empty screen after a failed load would delete everything.
        let vaultLoaded = false;

        const colorThemes = {
            orange: { primary: '#ff5011' }, cyan: { primary: '#17A2B8' }, green: { primary: '#51cf66' },
            purple: { primary: '#9370DB' }, pink: { primary: '#DF1783' }
        };

        // --- MATRIX BACKGROUND LOGIC ---
        let matrixInterval = null;
        let matrixThemeColor = '#ff5011';

        function initMatrix() {
            const canvas = document.getElementById('matrixCanvas');
            // The page may ship its own background effect instead.
            if (!canvas) return;
            const ctx = canvas.getContext('2d');
            let drops = [];

            function resizeCanvas() {
                canvas.width = window.innerWidth;
                canvas.height = window.innerHeight;
                drops = [];
                for(let x = 0; x < canvas.width / 14; x++) drops[x] = 1;
            }
            window.addEventListener('resize', resizeCanvas);
            resizeCanvas();

            const chars = '01アイウエオカキクケコサシスセソタチツテトナニヌネノ';

            function drawMatrix() {
                ctx.fillStyle = 'rgba(0, 0, 0, 0.05)'; 
                ctx.fillRect(0, 0, canvas.width, canvas.height);
                
                // Use dynamically injected theme color
                ctx.fillStyle = matrixThemeColor; 
                ctx.font = '14px monospace';
                
                for (let i = 0; i < drops.length; i++) {
                    const text = chars[Math.floor(Math.random() * chars.length)];
                    ctx.fillText(text, i * 14, drops[i] * 14);
                    
                    if (drops[i] * 14 > canvas.height && Math.random() > 0.975) {
                        drops[i] = 0;
                    }
                    drops[i]++;
                }
            }
            
            if(matrixInterval) clearInterval(matrixInterval);
            matrixInterval = setInterval(drawMatrix, 35);
        }

        // --- CORE INITIALIZATION ---
        document.addEventListener('DOMContentLoaded', () => {
            lucide.createIcons();
            Chart.defaults.color = 'hsl(242, 8%, 70%)';
            Chart.defaults.borderColor = 'rgba(255, 255, 255, 0.08)';

            // Mobile drawer: mirror the sidebar menu (the drawer had no links,
            // so the app could not be navigated below 992px).
            const mobileMenu = document.querySelector('.sidebar-menu').cloneNode(true);
            mobileMenu.querySelectorAll('[id]').forEach(el => el.removeAttribute('id'));
            document.getElementById('mobileNav').appendChild(mobileMenu);

            // Start Matrix Effect
            initMatrix();

            // A password-reset link lands here with its token in the URL
            // fragment. Take it out of the address bar at once so it is not
            // left in history or passed on with a copied URL.
            const recovery = window.DomainVaultAPI.recoveryFromUrl();
            if (recovery) {
                history.replaceState(null, '', location.pathname + location.search);
                if (recovery.accessToken) {
                    recoveryToken = recovery.accessToken;
                    setAuthMode('recover');
                } else {
                    setAuthMode('login');
                    showAuthMessage(`${recovery.error} Use "Forgot your password?" to get a new link.`, 'danger');
                }
            } else {
                // The landing page's sign-up buttons link to /app/?register,
                // its pricing table to /app/?register&plan=Business.
                const params = new URLSearchParams(location.search);
                if (params.has('register')) setAuthMode('register');
                pendingPlanChoice = canonicalPlan(params.get('plan'));
                // Restore a previous session, if there is one. The old build
                // logged you out on every refresh.
                window.DomainVaultAPI.restore().then(function (user) {
                    if (!user) return;
                    currentUser = user;
                    enterApp();
                });
            }

            // Setup Auth Overlay UI
            document.getElementById('tab-login').addEventListener('click', () => setAuthMode('login'));
            document.getElementById('tab-register').addEventListener('click', () => setAuthMode('register'));
            document.getElementById('authForm').addEventListener('submit', (e) => { e.preventDefault(); handleAuthSubmit(); });
            document.getElementById('forgotPasswordLink').addEventListener('click', () => setAuthMode('forgot'));
            document.getElementById('backToLoginLink').addEventListener('click', () => { recoveryToken = null; setAuthMode('login'); });
            document.getElementById('logoutBtn').addEventListener('click', () => handleLogout());
            document.getElementById('settingsPasswordForm').addEventListener('submit', submitPasswordChange);
            document.getElementById('exportCsvBtn').addEventListener('click', () => {
                if (domains.length === 0) return showToast("No domains to export yet.", "warning");
                downloadFile(`domain_vault_${todayStamp()}.csv`, 'text/csv', domainsCsv(domains));
            });
            document.getElementById('exportJsonBtn').addEventListener('click', exportJson);
            document.getElementById('settingsRemindersForm').addEventListener('submit', saveReminderSettings);
            document.getElementById('remindersEnabled').addEventListener('change', function () {
                settings.reminders = settings.reminders || {};
                settings.reminders.enabled = this.checked;
                applyReminderSettings();
            });

            // Setup Plan Badge Click Listener
            document.getElementById('upgradePlanBtn').addEventListener('click', () => openUpgrade());
            document.querySelectorAll('input[name="upgradeBilling"]').forEach(r =>
                r.addEventListener('change', () => loadPackPrices(document.getElementById('upgradePlanSelect').value)));

            // Modular Checkout Button Logic
            document.getElementById('proceedToCheckoutBtn').addEventListener('click', () => {
                const option = document.getElementById('upgradePlanSelect').selectedOptions[0];
                if (!option || option.disabled) return showToast("There is no larger pack available for this account right now.", "warning");
                const selectedPlan = option.value;
                const checkoutUrl = paypalCheckoutUrl(selectedPlan, billingMode());
                if (!checkoutUrl) return showToast("This pack is not available for purchase yet.", "danger");
                window.location.href = checkoutUrl;
            });

            // Modals & Navigation
            document.getElementById('addDomainBtn').addEventListener('click', () => {
                if (domains.length >= planLimit(currentUser?.plan || 'Personal')) return openUpgrade();
                openModal('domainModal', 'addNewDomain', 'addDomain', {});
            });
            document.getElementById('addDomainBtnSecondary').addEventListener('click', () => document.getElementById('addDomainBtn').click());
            document.getElementById('addProviderBtn').addEventListener('click', () => openModal('providerModal', 'addNewProvider', 'addProvider', {}));
            
            document.querySelectorAll('.modal-close').forEach(btn => {
                btn.addEventListener('click', (e) => closeModal(e.target.closest('.modal')));
            });
            window.addEventListener('click', (e) => {
                if (e.target.classList.contains('modal')) closeModal(e.target);
            });

            document.querySelectorAll('.menu-item').forEach(item => {
                item.addEventListener('click', (e) => {
                    const page = e.currentTarget.dataset.page;
                    if (!page) return;   // e.g. the Admin link navigates normally
                    setActivePage(page);
                });
            });

            // Forms
            document.getElementById('domainForm').addEventListener('submit', saveDomain);
            document.getElementById('providerForm').addEventListener('submit', saveProvider);
            document.getElementById('settingsProfileForm').addEventListener('submit', saveSettings);
            document.getElementById('domainProvider').addEventListener('change', function() {
                document.getElementById('otherProviderGroup').style.display = this.value === 'other' ? 'block' : 'none';
            });

            // Tools Filter
            const toolFilterBtns = document.querySelectorAll('#toolsFilterTags .filter-tag');
            toolFilterBtns.forEach(btn => {
                btn.addEventListener('click', (e) => {
                    toolFilterBtns.forEach(b => b.classList.remove('active'));
                    e.target.classList.add('active');
                    currentToolFilter = e.target.dataset.tag;
                    renderToolsPage();
                    lucide.createIcons();
                });
            });

            // Header Actions
            document.getElementById('translateBtn').addEventListener('click', async () => {
                settings.language = settings.language === 'en' ? 'es' : 'en';
                setLanguage(settings.language);
                if (currentUser) await persist('saveSettings', { settings }, null, false);
            });

            document.getElementById('headerNotificationIcon').addEventListener('click', () => setActivePage('notifications'));
            
            const costCard = document.getElementById('cost-card');
            if (costCard) {
                costCard.addEventListener('click', function() {
                    this.classList.toggle('is-flipped');
                });
            }

            // Re-written Password Toggles (Event Delegation to handle Lucide's SVG replacement)
            document.body.addEventListener('click', (e) => {
                const toggleIcon = e.target.closest('.toggle-password');
                if (toggleIcon) {
                    const wrapper = toggleIcon.closest('.password-wrapper');
                    const input = wrapper.querySelector('.form-control');
                    const isPassword = input.getAttribute('type') === 'password';
                    
                    input.setAttribute('type', isPassword ? 'text' : 'password');
                    
                    const newIcon = document.createElement('i');
                    newIcon.setAttribute('data-lucide', isPassword ? 'eye-off' : 'eye');
                    newIcon.className = 'toggle-password';
                    if(toggleIcon.id) newIcon.id = toggleIcon.id;
                    
                    toggleIcon.replaceWith(newIcon);
                    lucide.createIcons();
                }
            });

            // API specific actions
            document.getElementById('fetchWhoisBtn').addEventListener('click', fetchWhoisData);
            document.getElementById('quickDnsBtn').addEventListener('click', () => {
                const domain = document.getElementById('quickDnsInput').value.trim();
                if(domain) fetchDnsRecords(domain); else showToast('Please enter a domain.', 'warning');
            });

            // Reports Page Listeners
            document.getElementById('reportFilterForm').addEventListener('submit', (e) => {
                e.preventDefault();
                renderReportsPage();
            });

            document.getElementById('pageDownloadReportBtn').addEventListener('click', () => {
                if(currentReportData.length === 0) return showToast("No data to download.", "warning");
                downloadFile(`domain_report_${todayStamp()}.csv`, 'text/csv', domainsCsv(currentReportData));
                showToast("Report downloaded successfully!", "success");
            });

            document.getElementById('pageEmailReportBtn').addEventListener('click', () => {
                if(currentReportData.length === 0) return showToast("No data to email.", "warning");
                
                let body = "Domain Vault Report\n";
                body += "--------------------------------------------------\n\n";
                currentReportData.forEach(d => {
                    const rd = d.renewalDate ? d.renewalDate.split('T')[0] : 'N/A';
                    body += `Domain: ${d.name}\nProvider: ${d.provider}\nRenewal: ${rd}\nCost: $${d.renewalPrice}\n\n`;
                });
                body += "--------------------------------------------------\n";
                body += "Generated from Domain Vault Dashboard.";

                const subject = encodeURIComponent("Domain Vault - Data Report");
                const mailtoBody = encodeURIComponent(body);
                
                window.location.href = `mailto:${currentUser?.email || ''}?subject=${subject}&body=${mailtoBody}`;
                showToast("Opening default email client...", "success");
            });

            // Action Buttons delegation
            document.body.addEventListener('click', async (e) => { 
                const actionBtn = e.target.closest('.action-btn');
                if (!actionBtn) return;
                const domainId = actionBtn.dataset.id;
                
                if (actionBtn.title === 'Edit' || actionBtn.title === 'Editar Dominio') { 
                    const domain = domains.find(d => String(d.id) === String(domainId));
                    if(domain) openModal('domainModal', 'editDomain', 'addDomain', domain); 
                } 
                else if (actionBtn.title === 'Delete' || actionBtn.title === 'Eliminar') { 
                    deleteDomain(domainId);
                } 
                else if (actionBtn.title === 'Edit Provider' || actionBtn.title === 'Editar Proveedor') {
                    const provider = providers.find(p => String(p.id) === String(domainId));
                    if(provider) openModal('providerModal', 'editProvider', 'addProvider', provider);
                } 
                else if (actionBtn.title === 'Delete Provider') {
                    deleteProvider(domainId);
                } 
                else if (actionBtn.classList.contains('dns-btn')) {
                    const domain = domains.find(d => String(d.id) === String(domainId));
                    if (domain) fetchDnsRecords(domain.name);
                } 
                else if (actionBtn.classList.contains('gcal-btn')) {
                    const domain = domains.find(d => String(d.id) === String(domainId));
                    window.open(generateGoogleCalendarLink(domain), '_blank');
                } 
                else if (actionBtn.classList.contains('ical-btn')) {
                    const domain = domains.find(d => String(d.id) === String(domainId));
                    generateICal([domain]);
                } 
                else if (actionBtn.title === 'Delete Notification') {
                    const dismissed = notifications.find(n => String(n.id) === String(domainId));
                    if (dismissed) rememberDismissed(dismissed.key);
                    notifications = notifications.filter(n => String(n.id) !== String(domainId));
                    renderNotificationsPage(); 
                    updateNotificationBadge();
                    showToast('Notification cleared.');
                }
            });

            document.getElementById('providersGrid').addEventListener('click', (e) => {
                const target = e.target.closest('.credentials-btn');
                if (target) {
                    const provider = providers.find(p => String(p.id) === String(target.dataset.id));
                    openModal('credentialsModal', 'providerCredentials', '', provider);
                }
            });

            // Calendar Navigation
            document.getElementById('prevMonthBtn').addEventListener('click', () => {
                currentCalendarDate.setMonth(currentCalendarDate.getMonth() - 1);
                renderCalendar();
            });
            document.getElementById('nextMonthBtn').addEventListener('click', () => {
                currentCalendarDate.setMonth(currentCalendarDate.getMonth() + 1);
                renderCalendar();
            });
            document.getElementById('downloadIcsBtn').addEventListener('click', () => {
                const y = currentCalendarDate.getFullYear(), m = currentCalendarDate.getMonth();
                const renewals = domains.filter(d => {
                    if (!d.renewalDate) return false;
                    const rdStr = d.renewalDate.split('T')[0];
                    const rd = new Date(rdStr + 'T00:00:00');
                    return rd.getFullYear() === y && rd.getMonth() === m;
                });
                if (renewals.length > 0) generateICal(renewals, true);
                else showToast('No renewals this month to export.', 'danger');
            });
            document.getElementById('syncGCalBtn').addEventListener('click', openCalendarFeed);
            document.getElementById('copyFeedBtn').addEventListener('click', () => {
                const url = document.getElementById('calendarFeedUrl').value;
                if (/^https?:/.test(url)) copyToClipboard(url, 'Calendar link copied.');
            });
            document.getElementById('resetFeedBtn').addEventListener('click', async () => {
                if (!confirm("Create a new link? Calendars subscribed with the current link will stop updating.")) return;
                const res = await persist('resetCalendarFeed', {}, "New link created. Subscribe with it again in your calendar app.", false);
                if (res && res.token) setFeedUrl(res.token);
            });

            document.getElementById('credRevealBtn').addEventListener('click', async () => {
                const el = document.getElementById('credPass');
                if (el.dataset.shown === '1') { el.textContent = '••••••••'; el.dataset.shown = ''; return; }
                const password = await fetchStoredPassword();
                if (password === null) return;
                el.textContent = password;
                el.dataset.shown = '1';
            });
            document.getElementById('credCopyBtn').addEventListener('click', async () => {
                const password = await fetchStoredPassword();
                if (password !== null) copyToClipboard(password, 'Password copied.');
            });

            // Custom accent colour: preview while picking, save once chosen.
            const colorPicker = document.getElementById('customColorPicker');
            colorPicker.addEventListener('input', () => document.documentElement.style.setProperty('--primary', colorPicker.value));
            colorPicker.addEventListener('change', async () => {
                settings.theme = colorPicker.value;   // a hex value is stored as the theme itself
                applySettings();
                updateStats();
                if (currentUser) await persist('saveSettings', { settings }, "Accent color saved.", false);
            });

            // Mobile Nav
            document.querySelector('.menu-toggle').addEventListener('click', () => { document.getElementById('mobileNav').classList.add('open'); document.getElementById('navOverlay').classList.add('open'); lucide.createIcons(); });
            document.querySelector('.mobile-nav-close').addEventListener('click', () => { document.getElementById('mobileNav').classList.remove('open'); document.getElementById('navOverlay').classList.remove('open'); });
            document.getElementById('navOverlay').addEventListener('click', () => { document.getElementById('mobileNav').classList.remove('open'); document.getElementById('navOverlay').classList.remove('open'); });
            
            // Search Input Logic
            const searchInput = document.getElementById('searchInput');
            searchInput.addEventListener('input', (e) => { 
                const term = e.target.value.toLowerCase().trim(); 
                
                if (term !== '' && !document.getElementById('page-domains').classList.contains('active')) {
                    setActivePage('domains');
                }
                
                const filtered = domains.filter(d => 
                    d.name.toLowerCase().includes(term) || 
                    d.provider.toLowerCase().includes(term)
                );
                
                renderDomains(filtered); 
            });

            searchInput.addEventListener('keypress', (e) => {
                if (e.key === 'Enter') {
                    e.preventDefault();
                    if (!document.getElementById('page-domains').classList.contains('active')) setActivePage('domains');
                }
            });
        });

        // --- API & AUTH LOGIC ---
        
        const AUTH_MODES = {
            login:    { button: 'Log In' },
            register: { button: 'Register Account' },
            forgot:   { button: 'Send Reset Link', intro: "Enter your account email and we'll send you a link to choose a new password." },
            recover:  { button: 'Set New Password', intro: 'Choose a new password for your account.' }
        };

        /** One auth card, four jobs: log in, register, ask for a reset link, set a new password. */
        function setAuthMode(mode) {
            authMode = mode;
            isLoginMode = mode === 'login';
            const show = (id, on) => { document.getElementById(id).style.display = on ? '' : 'none'; };
            const intro = AUTH_MODES[mode].intro || '';

            document.getElementById('tab-login').classList.toggle('active', mode === 'login');
            document.getElementById('tab-register').classList.toggle('active', mode === 'register');
            document.querySelector('.auth-tabs').style.display = (mode === 'login' || mode === 'register') ? '' : 'none';
            document.getElementById('authIntro').textContent = intro;
            show('authIntro', !!intro);
            show('authEmailGroup', mode !== 'recover');
            show('authPasswordGroup', mode !== 'forgot');
            show('authPasswordHint', mode === 'register' || mode === 'recover');
            show('authConfirmGroup', mode === 'recover');
            show('registerFields', mode === 'register');
            show('forgotPasswordLink', mode === 'login');
            show('backToLoginLink', mode === 'forgot' || mode === 'recover');
            document.getElementById('authPasswordLabel').textContent = mode === 'recover' ? 'New password' : 'Password';
            document.getElementById('authPassword').setAttribute('autocomplete', mode === 'login' ? 'current-password' : 'new-password');
            document.getElementById('authSubmitBtn').textContent = AUTH_MODES[mode].button;
            document.getElementById('authMessage').style.display = 'none';
        }

        function showAuthMessage(text, type) {
            const el = document.getElementById('authMessage');
            el.style.display = 'block';
            el.style.color = type ? `var(--${type})` : 'var(--text-muted)';
            el.textContent = text;
        }

        function enterApp() {
            document.getElementById('auth-overlay').style.display = 'none';
            if (matrixInterval) clearInterval(matrixInterval); // Optimize performance
            loadDashboardData();
            handlePaymentReturn();
        }

        // Transport lives in api.js. It attaches the signed JWT,
        // refreshes it when it expires, and keeps the session across reloads.
        // Identity is taken from that token server-side, so the email these
        // call sites still pass is ignored.
        async function apiCall(action, payload = {}) {
            if (!window.DomainVaultAPI) {
                showToast("api.js did not load.", "danger");
                throw new Error("DomainVaultAPI missing");
            }
            return window.DomainVaultAPI.call(action, payload);
        }

        async function fetchLocation() {
            try {
                const res = await fetch('https://ipapi.co/json/');
                const data = await res.json();
                return `${data.city}, ${data.country_name}`;
            } catch (e) {
                return Intl.DateTimeFormat().resolvedOptions().timeZone;
            }
        }

        async function handleAuthSubmit() {
            const email = document.getElementById('authEmail').value.trim();
            const pass = document.getElementById('authPassword').value;
            const btn = document.getElementById('authSubmitBtn');

            if (authMode === 'forgot') {
                if (!email) return showAuthMessage("Enter your account email.", 'warning');
            } else if (authMode === 'recover') {
                if (pass.length < 10) return showAuthMessage("Your new password must be at least 10 characters.", 'danger');
                if (pass !== document.getElementById('authPasswordConfirm').value) return showAuthMessage("The two passwords do not match.", 'danger');
            } else {
                if (!email || !pass) return showToast("Email and password required.", "warning");
                if (authMode === 'register' && pass.length < 10) return showAuthMessage("Password must be at least 10 characters.", 'danger');
            }

            showAuthMessage('Processing...');
            btn.disabled = true;

            try {
                if (authMode === 'login') {
                    const res = await apiCall('loginUser', { email: email, password: pass });
                    if (res.success) {
                        currentUser = res.user;
                        enterApp();
                    } else {
                        showAuthMessage(res.message, 'danger');
                    }
                } else if (authMode === 'register') {
                    const place = await fetchLocation();
                    const phone = document.getElementById('authPhone').value;
                    const res = await apiCall('registerUser', { email: email, password: pass, phone: phone, location: place });
                    showAuthMessage(res.message, res.success ? 'success' : 'danger');
                    if (res.success) setTimeout(() => { if (authMode === 'register') setAuthMode('login'); }, 3000);
                } else if (authMode === 'forgot') {
                    // The link comes back to this page, wherever it is served from.
                    const res = await apiCall('requestPasswordReset', { email: email, redirectTo: location.origin + location.pathname });
                    showAuthMessage(res.message, res.success ? 'success' : 'danger');
                } else {
                    const res = await window.DomainVaultAPI.setPasswordWithRecovery(recoveryToken, pass);
                    if (res.success) {
                        recoveryToken = null;
                        document.getElementById('authForm').reset();
                        setAuthMode('login');
                        showAuthMessage("Password updated. Log in with your new password.", 'success');
                    } else {
                        showAuthMessage(res.message, 'danger');
                    }
                }
            } catch (err) {
                showAuthMessage("Connection error.", 'danger');
            } finally {
                btn.disabled = false;
            }
        }

        /** Sign out. `message`, if given, explains why (expired session, suspended account). */
        function handleLogout(message) {
            window.DomainVaultAPI.signOut();
            currentUser = null;
            document.querySelectorAll('.admin-link').forEach(a => { a.hidden = true; });
            document.querySelectorAll('.modal').forEach(m => { m.style.display = 'none'; });
            document.getElementById('auth-overlay').style.display = 'flex';
            document.getElementById('authForm').reset();
            setAuthMode('login');
            if (message) showAuthMessage(message, 'danger');
            domains = []; providers = []; notifications = []; purchases = []; subscriptions = [];
            vaultLoaded = false;
            // The desktop shell keeps reminding about the last list it was
            // given; a signed-out vault has none to show.
            if (window.domainVaultDesktop) {
                try { window.domainVaultDesktop.reportRenewals([], null); } catch (e) { /* no shell */ }
            }
            initMatrix(); // Restart Matrix rain
        }

        function loadDashboardData() {
            document.getElementById('userPlanBadgeText').textContent = currentUser.plan.toUpperCase();
            const limit = planLimit(currentUser.plan);
            document.getElementById('stat-domain-limit').textContent = `/ ${limit === Infinity ? '∞' : limit}`;

            document.getElementById('settingsAccountEmail').value = currentUser.email;

            apiCall('getUserData', {}).then(data => {
                // An expired session, or an account suspended since it last
                // signed in: showing an empty vault would invite the user to
                // start re-entering data that cannot be saved.
                if (!data || data.success === false) {
                    const message = (data && data.message) || "Please log in again.";
                    if ((data && data.expired) || /suspended|pending activation|not signed in/i.test(message)) {
                        return handleLogout(message);
                    }
                    return showToast(`Could not load your vault: ${message} Reload the page to try again.`, "danger");
                }
                domains = data.domains || [];
                providers = data.providers || [];
                purchases = data.purchases || [];
                subscriptions = data.subscriptions || [];
                vaultLoaded = true;
                if (data.settings) settings = Object.assign({}, settings, data.settings);
                else settings.username = currentUser.email.split('@')[0];
                applyAccountState(data);

                applySettings();
                setLanguage(settings.language);
                setActivePage('dashboard');
                renderAll();
                reportRenewalsToDesktop();
                if (pendingPlanChoice) {
                    openUpgrade(pendingPlanChoice);
                    pendingPlanChoice = null;
                }
            }).catch(err => {
                showToast("Could not reach the server to load your vault. Reload the page to try again.", "danger");
            });
        }

        /** Re-read domains, providers and plan, so the screen shows what the server holds. */
        async function reloadUserData() {
            const data = await apiCall('getUserData', {});
            if (!data || data.success === false) return;
            domains = data.domains || [];
            providers = data.providers || [];
            purchases = data.purchases || [];
            subscriptions = data.subscriptions || [];
            vaultLoaded = true;
            applyAccountState(data);
            renderAll();
        }

        /**
         * Send a change to the server. If it is refused (plan limit, duplicate
         * name, invalid value…) say why and, unless told otherwise, reload what
         * the server actually holds: the screen must never show a change that
         * was not saved. Resolves with the response, or null on failure.
         */
        async function persist(action, payload, successMessage, reloadOnFailure = true) {
            if (!vaultLoaded && (action === 'saveDomains' || action === 'saveProviders')) {
                showToast("Your vault has not loaded, so nothing was saved. Reload the page and try again.", "danger");
                return null;
            }
            let res;
            try {
                res = await apiCall(action, payload);
            } catch (err) {
                showToast("Could not reach the server. The change was not saved.", "danger");
                if (reloadOnFailure) reloadUserData().catch(() => {});
                return null;
            }
            if (!res || res.success === false) {
                const message = (res && res.message) || "The change was not saved.";
                if ((res && res.expired) || /suspended|pending activation|not signed in/i.test(message)) {
                    handleLogout(message);
                    return null;
                }
                showToast(message, "danger");
                if (reloadOnFailure) reloadUserData().catch(() => {});
                return null;
            }
            if (successMessage) showToast(successMessage, "success");
            return res;
        }

        // --- Renewal reminder preferences -------------------------------

        function applyReminderSettings() {
            var prefs = (settings && settings.reminders) || {};
            var enabled = prefs.enabled !== false;
            var channels = prefs.channels || ['email'];
            var leadDays = (prefs.leadDays || [30, 7, 1, 0]).map(Number);

            document.getElementById('remindersEnabled').checked = enabled;
            document.querySelectorAll('.reminder-channel').forEach(function (cb) {
                cb.checked = channels.indexOf(cb.value) !== -1;
            });
            document.querySelectorAll('.reminder-lead').forEach(function (cb) {
                cb.checked = leadDays.indexOf(Number(cb.value)) !== -1;
            });
            document.getElementById('reminderOptions').style.opacity = enabled ? '1' : '0.45';
            document.querySelectorAll('#reminderOptions input').forEach(function (cb) {
                cb.disabled = !enabled;
            });
        }

        async function saveReminderSettings(e) {
            e.preventDefault();
            var channels = Array.from(document.querySelectorAll('.reminder-channel:checked')).map(c => c.value);
            var leadDays = Array.from(document.querySelectorAll('.reminder-lead:checked')).map(c => Number(c.value));
            var enabled = document.getElementById('remindersEnabled').checked;

            // The server rejects empty sets; say so before the round trip.
            if (enabled && channels.length === 0) return showToast("Choose at least one way to be reminded.", "warning");
            if (enabled && leadDays.length === 0) return showToast("Choose at least one reminder time.", "warning");

            settings.reminders = { enabled: enabled, channels: channels, leadDays: leadDays };
            const res = await persist('saveSettings', { settings },
                enabled ? "Reminder settings saved." : "Renewal reminders switched off.", false);
            if (res) reportRenewalsToDesktop();
        }

        /**
         * In the desktop client, hand the shell the renewal dates so it can
         * raise native reminders. No-op in a browser, and deliberately sends
         * nothing but names and dates — never providers or credentials.
         */
        function reportRenewalsToDesktop() {
            if (!window.domainVaultDesktop) return;
            try {
                window.domainVaultDesktop.reportRenewals(
                    domains.map(d => ({ name: d.name, renewalDate: (d.renewalDate || '').split('T')[0] })),
                    settings.reminders || null);
            } catch (e) { /* the app works with or without the shell */ }
        }

        /** Sync plan + admin flag from a getUserData response into the UI and the stored session. */
        function applyAccountState(data) {
            if (data.plan) currentUser.plan = data.plan;
            currentUser.isAdmin = data.isAdmin === true;
            window.DomainVaultAPI.updateUser({ plan: currentUser.plan, isAdmin: currentUser.isAdmin });

            document.getElementById('userPlanBadgeText').textContent = currentUser.plan.toUpperCase();
            const limit = planLimit(currentUser.plan);
            const limitEl = document.getElementById('stat-domain-limit');
            if (limitEl) limitEl.textContent = `/ ${limit === Infinity ? '∞' : limit}`;
            document.querySelectorAll('.admin-link').forEach(a => { a.hidden = !currentUser.isAdmin; });
        }

        /**
         * Back from PayPal (?payment=success). The webhook usually lands within
         * seconds but can take longer, so poll a few times for the new plan.
         */
        async function handlePaymentReturn() {
            const params = new URLSearchParams(location.search);
            if (params.get('payment') !== 'success' || !currentUser) return;
            history.replaceState(null, '', location.pathname);

            const before = currentUser.plan;
            showToast("Payment received. Activating your pack…", "warning");
            for (let i = 0; i < 12; i++) {
                await new Promise(r => setTimeout(r, 5000));
                try {
                    const data = await apiCall('getUserData', {});
                    if (data && data.plan && data.plan !== before) {
                        applyAccountState(data);
                        renderAll();
                        return showToast(`Your ${data.plan} pack is active!`, "success");
                    }
                } catch (e) { /* keep polling */ }
            }
            showToast("Your payment is still being processed. Your plan will update shortly; refresh in a few minutes.", "warning");
        }

        let toastTimer = null;
        function showToast(message, type = 'success') {
            const toast = document.getElementById('toast');
            toast.textContent = message;
            toast.style.borderLeftColor = `var(--${type})`;
            toast.classList.add('show');
            // A newer toast gets its full time on screen.
            clearTimeout(toastTimer);
            toastTimer = setTimeout(() => toast.classList.remove('show'), type === 'danger' ? 5000 : 3000);
        }

        // --- RENDERING & UI ---

        const setLanguage = (lang) => {
            document.querySelectorAll('[data-translate-key]').forEach(el => {
                const key = el.dataset.translateKey;
                const translation = translations[lang][key];
                if (translation) {
                    if (el.placeholder) {
                        el.placeholder = translation;
                    } else {
                        const icon = el.querySelector('i');
                        if (icon && (el.classList.contains('btn') || el.parentElement.classList.contains('btn'))) {
                            const textNode = Array.from(el.childNodes).find(node => node.nodeType === Node.TEXT_NODE);
                            if (textNode) textNode.textContent = ` ${translation}`;
                        } else {
                            el.textContent = translation;
                        }
                    }
                }
            });
            renderAll();
            lucide.createIcons();
        };

        const renderGallery = (containerId, data, btnTranslateKey) => {
            const container = document.getElementById(containerId);
            if (!container) return;
            container.innerHTML = '';
            const lang = settings.language;
            
            data.forEach(item => {
                let starsHtml = '';
                for(let i=0; i<Math.floor(item.rating); i++) starsHtml += '<i data-lucide="star" style="fill: var(--primary); color: var(--primary);"></i>';
                if(item.rating % 1 !== 0) starsHtml += '<i data-lucide="star-half" style="fill: var(--primary); color: var(--primary);"></i>';

                container.innerHTML += `
                    <div class="recommendation-card">
                        <i data-lucide="${item.icon}" class="card-icon"></i>
                        <div class="gallery-info" style="flex-grow:1;">
                            <div class="gallery-title">${item.name}</div>
                            <div class="gallery-subtitle">${item.desc}</div>
                        </div>
                        <div class="gallery-rating">${starsHtml}</div>
                        <div class="gallery-action">
                            <a href="${item.url}" target="_blank" class="btn btn-secondary" style="width:100%; font-size: 0.9em; white-space:nowrap;">
                                ${translations[lang][btnTranslateKey] || 'Visit'} <i data-lucide="external-link" style="width: 14px; margin-left: 4px;"></i>
                            </a>
                        </div>
                    </div>
                `;
            });
        };

        const renderToolsPage = () => {
            const combinedResources = [...expandedRecommendationsData, ...toolsData];
            const filtered = currentToolFilter === 'all' 
                ? combinedResources 
                : combinedResources.filter(item => item.tags && item.tags.includes(currentToolFilter));
            renderGallery('toolsGridContainer', filtered, 'visitTool');
        };

        function renderAll() {
            renderDomains();
            renderProviders();
            updateStats();
            renderToolsPage();
            renderReportsPage();
            renderGallery('modalDomainRecsGrid', recommendedProvidersData, 'getDeal');
            renderGallery('modalProviderRecsGrid', recommendedProvidersData, 'getDeal');
            renderCalendar();
            updateNotifications();
            renderPurchases();
            lucide.createIcons();
        }

        const setActivePage = (pageId) => {
            document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
            document.getElementById(`page-${pageId}`).classList.add('active');
            document.querySelectorAll('.menu-item').forEach(m => {
                m.classList.toggle('active', m.dataset.page === pageId);
            });
            if(pageId === 'calendar') renderCalendar();
            if(pageId === 'reports') renderReportsPage();
            lucide.createIcons();
            document.getElementById('mobileNav').classList.remove('open');
            document.getElementById('navOverlay').classList.remove('open');
        };

        function escapeHTML(str) {
            if (typeof str !== 'string') return str;
            return str.replace(/[&<>'"]/g, tag => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[tag] || tag));
        }

        function applySettings() {
            applyReminderSettings();
            // A custom accent is saved as the theme itself ("#12abef").
            const customColor = /^#[0-9a-f]{6}$/i.test(settings.theme || '') ? settings.theme : null;
            if (customColor) {
                document.documentElement.style.setProperty('--primary', customColor);
            } else {
                const theme = colorThemes[settings.theme] || colorThemes.orange;
                document.documentElement.style.setProperty('--primary', theme.primary);
            }

            // Update Matrix color 
            matrixThemeColor = getComputedStyle(document.documentElement).getPropertyValue('--primary').trim() || '#ff5011';

            document.getElementById('userName').textContent = settings.username || 'User';
            const initials = (settings.username || 'User').split(' ').map(n => n[0]).join('').substring(0,2);
            
            [document.getElementById('userAvatar'), document.getElementById('settingsAvatarPreview')].forEach(avatar => {
                if (settings.profilePicture) {
                    avatar.style.backgroundImage = `url(${JSON.stringify(settings.profilePicture)})`;
                    avatar.textContent = '';
                } else {
                    avatar.style.backgroundImage = '';
                    avatar.textContent = initials;
                }
            });

            document.getElementById('settingUsername').value = settings.username || '';
            
            const colorPalette = document.getElementById('colorPalette');
            colorPalette.innerHTML = '';
            Object.keys(colorThemes).forEach(key => {
                const swatch = document.createElement('div');
                swatch.className = 'color-swatch';
                swatch.style.backgroundColor = colorThemes[key].primary;
                swatch.dataset.theme = key;
                if (key === settings.theme && settings.theme !== 'custom') swatch.classList.add('active');
                
                swatch.addEventListener('click', async () => {
                    settings.theme = key;
                    applySettings();
                    if(expensesChart) updateStats();
                    if(currentUser) await persist('saveSettings', { settings }, null, false);
                });
                colorPalette.appendChild(swatch);
            });
            document.getElementById('customColorPicker').value = customColor || (colorThemes[settings.theme] || colorThemes.orange).primary;
        }

        function renderDomains(filteredDomains = domains) {
            const tbody1 = document.getElementById('domainsTableBody');
            if (tbody1) tbody1.innerHTML = '';
            
            const lang = settings.language;
            const now = new Date(); now.setHours(0,0,0,0);
            
            const isFiltering = filteredDomains !== domains;
            
            if (!isFiltering) {
                const tbody2 = document.getElementById('urgentRenewalsBody');
                if (tbody2) {
                    tbody2.innerHTML = '';
                    let sortedAll = [...domains].sort((a,b) => new Date(a.renewalDate) - new Date(b.renewalDate));
                    if (sortedAll.length === 0) {
                        tbody2.innerHTML = `<tr><td colspan="4" style="text-align:center; padding: 20px;">${translations[lang].noDomainsFound}</td></tr>`;
                    } else {
                        sortedAll.slice(0, 5).forEach((d) => {
                            if(!d.renewalDate) return;
                            const rdStr = d.renewalDate.split('T')[0];
                            const renewalDateObj = new Date(rdStr + 'T00:00:00');
                            const diffDays = Math.ceil((renewalDateObj - now) / 86400000);
                            
                            tbody2.innerHTML += `<tr>
                                <td><strong>${escapeHTML(d.name)}</strong></td>
                                <td>${rdStr}</td>
                                <td style="color:${diffDays<0?'var(--danger)':'var(--warning)'}">${diffDays < 0 ? translations[lang].statusExpired : diffDays}</td>
                                <td>$${parseFloat(d.renewalPrice||0).toFixed(2)}</td>
                            </tr>`;
                        });
                    }
                }
            }

            let sorted = [...filteredDomains].sort((a,b) => new Date(a.renewalDate) - new Date(b.renewalDate));

            if (sorted.length === 0 && tbody1) {
                tbody1.innerHTML = `<tr><td colspan="6" style="text-align:center; padding: 20px;">${translations[lang].noDomainsFound}</td></tr>`;
            } else if (tbody1) {
                sorted.forEach((d) => {
                    if(!d.renewalDate) return;
                    const rdStr = d.renewalDate.split('T')[0];
                    const renewalDateObj = new Date(rdStr + 'T00:00:00');
                    const diffDays = Math.ceil((renewalDateObj - now) / 86400000);
                    
                    let statusCls = diffDays < 0 ? 'status-expired' : (diffDays <= 30 ? 'status-warning' : 'status-active');
                    let statusTxt = diffDays < 0 ? translations[lang].statusExpired : (diffDays <= 30 ? translations[lang].statusExpiringIn.replace('{days}', diffDays) : translations[lang].statusActive);

                    const tr = `<tr>
                        <td><strong>${escapeHTML(d.name)}</strong></td>
                        <td>${escapeHTML(d.provider)}</td>
                        <td>${rdStr}</td>
                        <td>$${parseFloat(d.renewalPrice||0).toFixed(2)}</td>
                        <td><span class="status ${statusCls}">${statusTxt}</span></td>
                        <td>
                            <span class="action-btn dns-btn" data-id="${d.id}" title="Check DNS"><i data-lucide="network"></i></span>
                            <span class="action-btn gcal-btn" data-id="${d.id}" title="Add to Google Calendar"><i data-lucide="calendar-plus"></i></span>
                            <span class="action-btn ical-btn" data-id="${d.id}" title="Download iCal Event"><i data-lucide="download"></i></span>
                            <span class="action-btn" data-id="${d.id}" title="Edit"><i data-lucide="pencil"></i></span>
                            <span class="action-btn" data-id="${d.id}" title="Delete"><i data-lucide="trash-2"></i></span>
                        </td>
                    </tr>`;
                    tbody1.innerHTML += tr;
                });
            }
            lucide.createIcons();
        }
        
        function renderReportsPage() {
            const tbody = document.getElementById('reportsTableBody');
            if (!tbody) return;
            
            const startDate = document.getElementById('reportPageStartDate').value;
            const endDate = document.getElementById('reportPageEndDate').value;
            const lang = settings.language;
            
            currentReportData = domains.filter(d => {
                if (!d.renewalDate) return false;
                const rdStr = d.renewalDate.split('T')[0];
                if (startDate && rdStr < startDate) return false;
                if (endDate && rdStr > endDate) return false;
                return true;
            }).sort((a,b) => new Date(a.renewalDate) - new Date(b.renewalDate));

            tbody.innerHTML = '';
            if(currentReportData.length === 0) {
                tbody.innerHTML = `<tr><td colspan="6" style="text-align:center; padding: 20px;">${translations[lang].noDomainsFound}</td></tr>`;
                return;
            }

            currentReportData.forEach(d => {
                const pdStr = d.purchaseDate ? d.purchaseDate.split('T')[0] : 'N/A';
                const rdStr = d.renewalDate ? d.renewalDate.split('T')[0] : 'N/A';
                
                tbody.innerHTML += `<tr>
                    <td><strong>${escapeHTML(d.name)}</strong></td>
                    <td>${escapeHTML(d.provider)}</td>
                    <td>${pdStr}</td>
                    <td>${rdStr}</td>
                    <td>$${parseFloat(d.purchasePrice||0).toFixed(2)}</td>
                    <td>$${parseFloat(d.renewalPrice||0).toFixed(2)}</td>
                </tr>`;
            });
        }

        function renderProviders() {
            const tbody = document.getElementById('providersTableBody');
            const grid = document.getElementById('providersGrid');
            if(tbody) tbody.innerHTML = '';
            if(grid) grid.innerHTML = '';
            const lang = settings.language;

            providers.forEach(p => {
                const count = domains.filter(d => d.provider.toLowerCase() === p.name.toLowerCase()).length;
                const autoRenewCount = domains.filter(d => d.provider.toLowerCase() === p.name.toLowerCase() && d.autoRenew).length;
                
                if(tbody) {
                    tbody.innerHTML += `<tr>
                        <td><strong>${escapeHTML(p.name)}</strong></td>
                        <td><a href="${escapeHTML(p.url)}" target="_blank" style="color:var(--primary)">${escapeHTML(p.url)}</a></td>
                        <td>${escapeHTML(p.user)}</td>
                        <td>${count}</td>
                        <td>
                            <span class="action-btn" data-id="${p.id}" title="Edit Provider"><i data-lucide="pencil"></i></span>
                            <span class="action-btn" data-id="${p.id}" title="Delete Provider"><i data-lucide="trash-2"></i></span>
                        </td>
                    </tr>`;
                }

                if(grid) {
                    grid.innerHTML += `
                        <div class="provider-card">
                            <div class="provider-header">
                                <div class="provider-info">
                                    <img src="https://www.google.com/s2/favicons?sz=64&domain_url=${escapeHTML(p.url)}" onerror="this.onerror=null;this.src='https://placehold.co/64x64/333/999?text=${escapeHTML(p.name).substring(0,2)}';" class="provider-logo">
                                    <h3 class="provider-name">${escapeHTML(p.name)}</h3>
                                </div>
                                <div class="actions">
                                    <span class="action-btn" data-id="${p.id}" title="Edit Provider"><i data-lucide="pencil"></i></span>
                                    <span class="action-btn" data-id="${p.id}" title="Delete Provider"><i data-lucide="trash-2"></i></span>
                                </div>
                            </div>
                            <div class="provider-stats">
                                <p>${translations[lang].domainsRegistered}: <span>${count}</span></p>
                                <p>${translations[lang].autoRenewal}: <span>${autoRenewCount}/${count}</span></p>
                            </div>
                            <div class="provider-actions">
                                 <a href="${escapeHTML(p.url)}" target="_blank" class="btn btn-open-page"><i data-lucide="external-link"></i> ${translations[lang].openPage}</a>
                                 <button class="btn btn-credentials credentials-btn" data-id="${p.id}"><i data-lucide="key-round"></i> ${translations[lang].viewCredentials}</button>
                            </div>
                        </div>`;
                }
            });
            lucide.createIcons();
        }

        function updateStats() {
            const statLimit = planLimit(currentUser?.plan || 'Personal');
            document.getElementById('stat-total-domains').innerHTML = `${domains.length} <span id="stat-domain-limit" style="font-size: 14px; color:var(--text-muted);">/ ${statLimit === Infinity ? '∞' : statLimit}</span>`;
            
            const uniqueProviders = [...new Set(domains.map(d => d.provider))].length;
            document.getElementById('stat-domain-providers').textContent = uniqueProviders;

            const totalExp = domains.reduce((s,d) => s + parseFloat(d.renewalPrice||0), 0);
            
            // --- NEW LOGIC FOR TOTAL INVESTMENT ---
            const totalInv = domains.reduce((s, d) => {
                let spent = parseFloat(d.purchasePrice || 0);
                if (d.purchaseDate && d.renewalDate) {
                    const pYear = new Date(d.purchaseDate.split('T')[0]).getFullYear();
                    const rYear = new Date(d.renewalDate.split('T')[0]).getFullYear();
                    const renewalsPaid = Math.max(0, rYear - pYear - 1);
                    spent += (renewalsPaid * parseFloat(d.renewalPrice || 0));
                }
                return s + spent;
            }, 0);
            
            document.getElementById('stat-yearly-expenses').textContent = `$${totalExp.toFixed(2)}`;
            const invEl = document.getElementById('stat-total-investment');
            if(invEl) invEl.textContent = `$${totalInv.toFixed(2)}`;

            const now = new Date(); now.setHours(0,0,0,0);
            const expSoon = domains.filter(d => {
                if(!d.renewalDate) return false;
                const rdStr = d.renewalDate.split('T')[0];
                const diffDays = Math.ceil((new Date(rdStr+'T00:00:00') - now)/86400000);
                return diffDays >= 0 && diffDays <= 30;
            }).length;
            document.getElementById('stat-expiring-soon').textContent = expSoon;

            // Charts
            const monthly = Array(12).fill(0);
            domains.forEach(d => {
                if(!d.renewalDate) return;
                const rdStr = d.renewalDate.split('T')[0];
                const m = new Date(rdStr+'T00:00:00').getMonth();
                monthly[m] += parseFloat(d.renewalPrice||0);
            });

            let primaryColor = document.documentElement.style.getPropertyValue('--primary').trim() || '#ff5011';
            
            if(expensesChart) expensesChart.destroy();
            expensesChart = new Chart(document.getElementById('expensesChart').getContext('2d'), { 
                type: 'line', 
                data: { 
                    labels: ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'], 
                    datasets: [{ label: 'Renewal Cost', data: monthly, backgroundColor: 'rgba(255, 80, 17, 0.1)', borderColor: primaryColor, borderWidth: 2, fill: true, tension: 0.3 }] 
                }, 
                options: { responsive: true, plugins: { legend: { display: false } } } 
            });

            // Providers Chart
            const pChartCanvas = document.getElementById('providersChart');
            if(pChartCanvas) {
                const providerCounts = domains.reduce((acc, d) => { acc[d.provider] = (acc[d.provider] || 0) + 1; return acc; }, {});
                const sortedProviders = Object.entries(providerCounts).sort(([,a],[,b]) => b-a);
                let pLabels = [], pData = [];
                if (sortedProviders.length > 3) {
                    sortedProviders.slice(0, 3).forEach(([n, c]) => { pLabels.push(n); pData.push(c); });
                    const oCount = sortedProviders.slice(3).reduce((sum, [, c]) => sum + c, 0);
                    if(oCount > 0) { pLabels.push('Others'); pData.push(oCount); }
                } else {
                    sortedProviders.forEach(([n, c]) => { pLabels.push(n); pData.push(c); });
                }
                const pColors = Object.values(colorThemes).map(t => t.primary).concat(['#ffd43b', '#51cf66']);
                
                if(window.providersChartInst) window.providersChartInst.destroy();
                window.providersChartInst = new Chart(pChartCanvas.getContext('2d'), { 
                    type: 'doughnut', 
                    data: { labels: pLabels, datasets: [{ data: pData, backgroundColor: pColors, borderWidth: 1, borderColor: 'var(--bg-card)' }] }, 
                    options: { responsive: true, plugins: { legend: { position: 'bottom', labels:{color:'#fff'} } } } 
                });
            }
        }

        const renderCalendar = () => {
            const year = currentCalendarDate.getFullYear();
            const month = currentCalendarDate.getMonth();
            const lang = settings.language;

            document.getElementById('currentMonthYear').textContent = new Date(year, month).toLocaleDateString(lang, { month: 'long', year: 'numeric' });
            const calGrid = document.getElementById('calendarGrid');
            const dayNamesEl = document.getElementById('calendarDayNames');
            calGrid.innerHTML = ''; dayNamesEl.innerHTML = '';

            translations[lang].dayNames.forEach(day => { dayNamesEl.innerHTML += `<div class="calendar-day-name">${day}</div>`; });

            const firstDay = new Date(year, month, 1).getDay();
            const daysInMonth = new Date(year, month + 1, 0).getDate();

            for(let i = 0; i < firstDay; i++) calGrid.innerHTML += `<div class="calendar-day other-month"></div>`;

            for(let day = 1; day <= daysInMonth; day++) {
                const dayEl = document.createElement('div');
                dayEl.className = 'calendar-day';
                dayEl.innerHTML = `<div class="day-number">${day}</div>`;
                
                const renewals = domains.filter(d => {
                    if(!d.renewalDate) return false;
                    const rdStr = d.renewalDate.split('T')[0];
                    const rd = new Date(rdStr + 'T00:00:00');
                    return rd.getFullYear() === year && rd.getMonth() === month && rd.getDate() === day;
                });

                renewals.forEach(d => {
                    dayEl.innerHTML += `<div class="calendar-event"><i data-lucide="globe" style="width: 12px; height: 12px;"></i>${escapeHTML(d.name)}</div>`;
                });
                calGrid.appendChild(dayEl);
            }
            lucide.createIcons();
        };

        const updateNotifications = () => {
            const now = new Date(); now.setHours(0,0,0,0);
            const lang = settings.language;
            const expiringDomains = domains.filter(d => {
                if(!d.renewalDate) return false;
                const rdStr = d.renewalDate.split('T')[0];
                return Math.ceil((new Date(rdStr+'T00:00:00') - now) / 86400000) <= 30;
            });
            const expIds = expiringDomains.map(d => String(d.id));
            
            notifications = notifications.filter(n => expIds.includes(String(n.domainId)));
            const notifIds = notifications.map(n => String(n.domainId));
            const newNotifs = [];

            const dismissed = loadDismissed();
            expiringDomains.forEach(d => {
                const rdStr = d.renewalDate.split('T')[0];
                const key = `${d.id}|${rdStr}`;
                if (!notifIds.includes(String(d.id)) && !dismissed.includes(key)) {
                    const diff = Math.ceil((new Date(rdStr+'T00:00:00') - now) / 86400000);
                    // Domain names are user input: escape before they reach innerHTML.
                    const name = escapeHTML(d.name);
                    let msg = diff <= 0 ? `<strong>${name}</strong> ${translations[lang].statusExpired}!` : `<strong>${name}</strong> ${translations[lang].statusExpiringIn.replace('{days}', diff)}`;
                    const n = { id: Date.now()+d.id, domainId: String(d.id), key: key, message: msg, type: diff <= 0 ? 'expired' : 'expiring' };
                    notifications.push(n);
                    newNotifs.push(n);
                }
            });

            renderNotificationsPage();
            updateNotificationBadge();
            if(newNotifs.length > 0) renderPopUpNotifications(newNotifs);
        };

        const renderNotificationsPage = () => {
            const list = document.getElementById('notificationsList');
            if(!list) return;
            list.innerHTML = '';
            if(notifications.length === 0) {
                list.innerHTML = `<p class="placeholder">${translations[settings.language].noNotifications}</p>`;
                return;
            }
            notifications.forEach(n => {
                list.innerHTML += `<div class="notification-item ${n.type}">
                    <p>${n.message}</p><span class="action-btn" data-id="${n.id}" title="Delete Notification"><i data-lucide="trash-2"></i></span>
                </div>`;
            });
            lucide.createIcons();
        };

        // Pop-ups sit over the page's action buttons, so they leave on their
        // own; the Notifications page and the badge keep the full list.
        const POPUP_LIMIT = 3, POPUP_SECONDS = 10;
        const renderPopUpNotifications = (arr) => {
            const c = document.getElementById('persistent-notifications-container');
            c.innerHTML = '';
            const dismiss = (el) => { el.classList.add('fading'); setTimeout(() => el.remove(), 400); };
            arr.slice(0, POPUP_LIMIT).forEach(n => {
                const el = document.createElement('div');
                el.className = `persistent-notification ${n.type}`;
                el.innerHTML = `<p>${n.message}</p><button class="notification-dismiss-btn" aria-label="Dismiss">&times;</button>`;
                el.querySelector('button').addEventListener('click', () => dismiss(el));
                c.appendChild(el);
                setTimeout(() => dismiss(el), POPUP_SECONDS * 1000);
            });
            if (arr.length > POPUP_LIMIT) {
                const more = document.createElement('div');
                more.className = 'persistent-notification';
                more.innerHTML = `<p>+${arr.length - POPUP_LIMIT} more in Notifications</p>`;
                more.style.cursor = 'pointer';
                more.addEventListener('click', () => { setActivePage('notifications'); dismiss(more); });
                c.appendChild(more);
                setTimeout(() => dismiss(more), POPUP_SECONDS * 1000);
            }
        };

        const updateNotificationBadge = () => {
            document.querySelectorAll('.notification-badge').forEach(b => b.textContent = notifications.length > 0 ? notifications.length : '');
        };

        // --- EXTERNAL APIs ---
        
        /** "https://www.Example.com/path" → "www.example.com". */
        function normalizeDomain(input) {
            return String(input || '').trim().toLowerCase()
                .replace(/^[a-z][a-z0-9+.-]*:\/\//, '').replace(/[\/?#:].*$/, '').replace(/\.$/, '');
        }

        /** yyyy-mm-dd from whatever date format WHOIS returned, or '' if it cannot be read. */
        function isoDay(value) {
            const d = new Date(value);
            return isNaN(d) ? '' : d.toISOString().substring(0, 10);
        }

        // WHOIS and DNS go through our lookup function, which validates the
        // name, caches answers and rate limits per user, instead of every
        // browser calling the upstream services directly.
        async function fetchWhoisData() {
            const domain = normalizeDomain(document.getElementById('domainName').value);
            const status = document.getElementById('whoisStatus');
            const lang = settings.language;
            if (!domain) return showToast('Please enter a domain name first.', 'warning');

            status.style.display = 'block'; status.style.color = 'var(--text-muted)';
            status.textContent = translations[lang].fetching;

            try {
                const res = await window.DomainVaultAPI.lookup(domain, 'whois');
                const data = res && res.success ? res.data : null;
                if (data && data.status === 'OK' && data.whois && Object.keys(data.whois).length > 0) {
                    document.getElementById('domainName').value = domain;
                    const created = isoDay(data.whois.creation_date);
                    const expires = isoDay(data.whois.expiry_date);
                    if (created) document.getElementById('purchaseDate').value = created;
                    if (expires) document.getElementById('renewalDate').value = expires;
                    if (data.whois.registrar) {
                        const sel = document.getElementById('domainProvider');
                        const rName = String(data.whois.registrar).toLowerCase();
                        let match = Array.from(sel.options).find(o => o.value && o.value !== 'other' && rName.includes(o.value.toLowerCase()));
                        if(match) sel.value = match.value;
                        else {
                            sel.value = 'other';
                            document.getElementById('otherProviderGroup').style.display = 'block';
                            document.getElementById('otherProvider').value = data.whois.registrar;
                        }
                    }
                    status.style.color = 'var(--success)'; status.textContent = translations[lang].whoisSuccess;
                } else {
                    status.style.color = 'var(--danger)';
                    status.textContent = (res && res.success === false && (res.error || res.message)) || translations[lang].whoisError;
                }
            } catch(e) {
                status.style.color = 'var(--danger)'; status.textContent = translations[lang].whoisError;
            }
        }

        async function fetchDnsRecords(input) {
            const domain = normalizeDomain(input);
            const showError = (text) => {
                document.getElementById('dnsLoading').style.display = 'none';
                document.getElementById('dnsError').style.display = 'block';
                document.getElementById('dnsError').textContent = text;
            };
            document.getElementById('dnsDomainLabel').textContent = domain;
            document.getElementById('dnsModal').style.display = 'flex';
            document.getElementById('dnsTableWrapper').style.display = 'none';
            document.getElementById('dnsError').style.display = 'none';
            document.getElementById('dnsLoading').style.display = 'block';

            try {
                const res = await window.DomainVaultAPI.lookup(domain, 'dns', ['A', 'AAAA', 'MX', 'TXT', 'CNAME', 'NS']);
                if (!res || res.success === false) return showError((res && (res.error || res.message)) || "Error connecting to DNS API.");

                document.getElementById('dnsLoading').style.display = 'none';
                // A CNAME shows up in the answer to several record types; list it once.
                const seen = new Set();
                const answers = [];
                Object.values(res.data || {}).forEach(d => {
                    (d && Array.isArray(d.Answer) ? d.Answer : []).forEach(r => {
                        const k = r.type + '|' + r.data;
                        if (!seen.has(k)) { seen.add(k); answers.push(r); }
                    });
                });

                if (answers.length > 0) {
                    const tbody = document.getElementById('dnsTableBody');
                    tbody.innerHTML = '';
                    const map = { 1: 'A', 2: 'NS', 5: 'CNAME', 15: 'MX', 16: 'TXT', 28: 'AAAA' };
                    answers.sort((a, b) => a.type - b.type).forEach(r => {
                        tbody.innerHTML += `<tr><td><span class="dns-badge">${map[r.type]||'Type '+escapeHTML(String(r.type))}</span></td><td style="word-break: break-all;">${escapeHTML(r.data)}</td></tr>`;
                    });
                    document.getElementById('dnsTableWrapper').style.display = 'block';
                } else {
                    showError(translations[settings.language].noDnsFound);
                }
            } catch(e) {
                showError("Error connecting to DNS API.");
            }
        }

        // --- CRUD LOGIC ---

        function openModal(id, titleKey, btnTextKey, data) {
            const m = document.getElementById(id);
            const lang = settings.language;
            
            if(id === 'domainModal') {
                m.querySelector('#modalTitle').textContent = translations[lang][titleKey];
                m.querySelector('#formSubmitBtn').textContent = translations[lang][btnTextKey];
                document.getElementById('domainId').value = data.id || '';
                document.getElementById('domainName').value = data.name || '';
                document.getElementById('purchaseDate').value = data.purchaseDate ? data.purchaseDate.split('T')[0] : '';
                document.getElementById('renewalDate').value = data.renewalDate ? data.renewalDate.split('T')[0] : '';
                document.getElementById('purchasePrice').value = data.purchasePrice || '';
                document.getElementById('renewalPrice').value = data.renewalPrice || '';
                document.getElementById('domainAutoRenew').checked = data.autoRenew || false;
                document.getElementById('whoisStatus').style.display = 'none';

                const sel = document.getElementById('domainProvider');
                sel.innerHTML = `<option value="">${translations[lang].selectProvider || 'Select Provider'}</option>`;
                providers.forEach(p => sel.appendChild(new Option(p.name, p.name)));
                sel.appendChild(new Option(`${translations[lang].other || 'Other'}...`, 'other'));
                sel.value = data.provider || '';
                document.getElementById('otherProviderGroup').style.display = sel.value === 'other' ? 'block' : 'none';
            } else if(id === 'providerModal') {
                m.querySelector('#providerModalTitle').textContent = translations[lang][titleKey];
                m.querySelector('#providerFormSubmitBtn').textContent = translations[lang][btnTextKey];
                document.getElementById('providerId').value = data.id || '';
                document.getElementById('providerName').value = data.name || '';
                document.getElementById('providerUrl').value = data.url || '';
                document.getElementById('providerUser').value = data.user || '';
                // The stored password is never sent to the browser. Leaving this
                // blank keeps whatever is stored; typing replaces it.
                document.getElementById('providerPass').value = '';
                document.getElementById('providerPass').placeholder =
                    data.hasPassword ? '•••••••• (unchanged)' : 'No password stored';
                document.getElementById('providerRemovePass').checked = false;
                document.getElementById('providerRemovePassGroup').style.display = data.hasPassword ? '' : 'none';
                document.getElementById('providerUid').value = data.uid || '';
            } else if(id === 'credentialsModal') {
                m.querySelector('#credentialsModalTitle').textContent = `${data.name} ${translations[lang].providerCredentials}`;
                document.getElementById('credUser').textContent = data.user || 'Not set';
                credentialsProviderId = data.id;
                revealedPassword = null;
                const credPass = document.getElementById('credPass');
                credPass.textContent = data.hasPassword ? '••••••••' : 'Not set';
                credPass.dataset.shown = '';
                ['credRevealBtn', 'credCopyBtn', 'credPassNote'].forEach(el => {
                    document.getElementById(el).style.display = data.hasPassword ? '' : 'none';
                });
                document.getElementById('credUid').textContent = data.uid || 'Not set';
            }
            m.style.display = 'flex';
        }

        function closeModal(m) {
            m.style.display = 'none';
            if (m.id === 'credentialsModal') {
                // Do not keep a revealed password around once it is off screen.
                revealedPassword = null;
                document.getElementById('credPass').textContent = '';
            }
            if (m.querySelector('form')) m.querySelector('form').reset();
            if (m.id === 'domainModal') document.getElementById('otherProviderGroup').style.display = 'none';
        }
        
        async function saveDomain(e) {
            e.preventDefault();
            let pName = document.getElementById('domainProvider').value;
            let isNewProvider = false;

            if (pName === 'other') {
                const oName = document.getElementById('otherProvider').value.trim();
                if (!oName) return showToast("Enter the provider's name.", "warning");
                if (!providers.some(p => p.name.toLowerCase() === oName.toLowerCase())) {
                    providers.push({ id: newId('prov'), name: oName, url: '', user: '', uid: '', hasPassword: false });
                    isNewProvider = true;
                }
                pName = oName;
            }

            const id = document.getElementById('domainId').value || newId('dom');
            const domain = {
                id: id,
                name: document.getElementById('domainName').value.trim(),
                provider: pName,
                purchaseDate: document.getElementById('purchaseDate').value,
                renewalDate: document.getElementById('renewalDate').value,
                purchasePrice: parseFloat(document.getElementById('purchasePrice').value || 0),
                renewalPrice: parseFloat(document.getElementById('renewalPrice').value || 0),
                autoRenew: document.getElementById('domainAutoRenew').checked
            };

            const idx = domains.findIndex(d => String(d.id) === String(id));
            if (idx > -1) domains[idx] = domain; else domains.push(domain);

            closeModal(document.getElementById('domainModal'));
            renderAll();

            if (!await persist('saveDomains', { domains }, isNewProvider ? null : "Domain saved.")) return;
            if (isNewProvider && await persist('saveProviders', { providers: providersPayload() }, "Domain saved.")) {
                clearPendingSecrets();
                renderProviders();
            }
            reportRenewalsToDesktop();
        }

        async function deleteDomain(id) {
            if(confirm("Delete this domain?")) {
                domains = domains.filter(d => String(d.id) !== String(id));
                renderAll();
                if (await persist('saveDomains', { domains }, "Domain deleted.")) reportRenewalsToDesktop();
            }
        }

        /**
         * What saveProviders sends. A password goes out only when the user just
         * typed one; a blank one tells the server to keep what it stores.
         */
        function providersPayload() {
            return providers.map(p => ({
                id: p.id, name: p.name, url: p.url, user: p.user, uid: p.uid,
                pass: p.pass || '',
                removePassword: p.removePassword === true
            }));
        }

        /** After a save, typed passwords and delete flags have done their job. */
        function clearPendingSecrets() {
            providers.forEach(p => { delete p.pass; delete p.removePassword; });
        }

        async function saveProvider(e) {
            e.preventDefault();
            const id = document.getElementById('providerId').value || newId('prov');
            const newName = document.getElementById('providerName').value.trim();
            const idx = providers.findIndex(p => String(p.id) === String(id));
            const existing = idx > -1 ? providers[idx] : null;
            const pass = document.getElementById('providerPass').value;
            const removePassword = !pass && document.getElementById('providerRemovePass').checked;

            const provider = {
                id: id, name: newName,
                url: document.getElementById('providerUrl').value.trim(),
                user: document.getElementById('providerUser').value.trim(),
                uid: document.getElementById('providerUid').value.trim(),
                pass: pass,
                removePassword: removePassword,
                hasPassword: pass ? true : (removePassword ? false : !!(existing && existing.hasPassword))
            };

            let nameChanged = false;
            if (existing) {
                const oldName = existing.name;
                if(oldName !== newName) {
                    domains.forEach(d => { if(d.provider === oldName) d.provider = newName; });
                    nameChanged = true;
                }
                providers[idx] = provider;
            } else {
                providers.push(provider);
            }

            closeModal(document.getElementById('providerModal'));
            renderAll();

            const saved = await persist('saveProviders', { providers: providersPayload() }, "Provider saved.");
            clearPendingSecrets();
            if (saved && nameChanged) await persist('saveDomains', { domains });
        }

        async function deleteProvider(id) {
            const p = providers.find(x => String(x.id) === String(id));
            if (!p) return;
            if(domains.some(d => d.provider === p.name)) return showToast('Cannot delete a provider with active domains.', 'danger');

            if(confirm(`Delete ${p.name}?`)) {
                providers = providers.filter(x => String(x.id) !== String(id));
                renderProviders();
                await persist('saveProviders', { providers: providersPayload() }, "Provider deleted.");
            }
        }

        async function saveSettings(e) {
            e.preventDefault();
            settings.username = document.getElementById('settingUsername').value.trim();

            const fileInput = document.getElementById('profilePicUpload');
            const file = fileInput.files[0];
            if (!file) {
                applySettings();
                await persist('saveSettings', { settings }, "Settings saved.", false);
                return;
            }

            // Same limits the server applies; say so before uploading.
            fileInput.value = '';
            if (!/^image\/(png|jpe?g|webp|gif)$/i.test(file.type)) return showToast("Use a PNG, JPEG, WebP or GIF image.", "warning");
            if (file.size > 2 * 1024 * 1024) return showToast("Profile pictures must be under 2 MB.", "warning");

            const dataUrl = await new Promise((resolve, reject) => {
                const reader = new FileReader();
                reader.onload = () => resolve(reader.result);
                reader.onerror = reject;
                reader.readAsDataURL(file);
            });
            const previous = settings.profilePicture;
            settings.profilePicture = dataUrl;
            applySettings();
            const res = await persist('saveSettings', { settings }, "Settings and picture saved.", false);
            // Keep the stored URL rather than the image itself, so later saves
            // do not upload the picture all over again.
            settings.profilePicture = res ? (res.profilePicture || '') : previous;
            applySettings();
        }

        async function submitPasswordChange(e) {
            e.preventDefault();
            const current = document.getElementById('currentPassword').value;
            const next = document.getElementById('newPassword').value;
            if (next.length < 10) return showToast("Your new password must be at least 10 characters.", "warning");
            if (next !== document.getElementById('confirmNewPassword').value) return showToast("The new passwords do not match.", "warning");

            const res = await persist('changePassword', { currentPassword: current, newPassword: next }, null, false);
            if (res) {
                e.target.reset();
                document.getElementById('settingsAccountEmail').value = currentUser.email;
                showToast(res.message || "Password changed.");
            }
        }

        // --- CALENDAR SUBSCRIPTION ---

        async function openCalendarFeed() {
            setFeedUrl(null);
            document.getElementById('calendarFeedModal').style.display = 'flex';
            const res = await persist('getCalendarFeed', {}, null, false);
            if (res && res.token) setFeedUrl(res.token);
        }

        function setFeedUrl(token) {
            const input = document.getElementById('calendarFeedUrl');
            const google = document.getElementById('googleFeedLink');
            const webcal = document.getElementById('webcalFeedLink');
            if (!token) {
                input.value = 'Loading…';
                google.removeAttribute('href');
                webcal.removeAttribute('href');
                return;
            }
            const url = window.DomainVaultAPI.calendarFeedUrl(token);
            const webcalUrl = url.replace(/^https?:\/\//, 'webcal://');
            input.value = url;
            // Google's "add by URL" dialog, pre-filled.
            google.href = 'https://calendar.google.com/calendar/r?cid=' + encodeURIComponent(webcalUrl);
            webcal.href = webcalUrl;
        }

        // --- STORED PASSWORDS ---

        /** The provider's stored password, fetched once per opening of the credentials modal. */
        async function fetchStoredPassword() {
            if (revealedPassword !== null) return revealedPassword;
            const res = await persist('revealCredential', { providerId: credentialsProviderId }, null, false);
            if (!res) return null;
            revealedPassword = res.password;
            return revealedPassword;
        }

        async function copyToClipboard(text, doneMessage) {
            try {
                await navigator.clipboard.writeText(text);
                showToast(doneMessage);
            } catch (e) {
                showToast("Copying is blocked here. Select the text and copy it by hand.", "warning");
            }
        }

        // --- EXPORTS ---

        function todayStamp() { return new Date().toISOString().split('T')[0]; }

        function newId(prefix) {
            return window.crypto && crypto.randomUUID ? crypto.randomUUID() : `${prefix}_${Date.now()}`;
        }

        function downloadFile(filename, mime, content) {
            const a = document.createElement('a');
            a.href = URL.createObjectURL(new Blob([content], { type: mime }));
            a.download = filename;
            document.body.appendChild(a); a.click(); document.body.removeChild(a);
            setTimeout(() => URL.revokeObjectURL(a.href), 1000);
        }

        /** One CSV field: quoted, and defused if a spreadsheet would run it as a formula. */
        function csvField(value) {
            let v = value === null || value === undefined ? '' : String(value);
            if (/^[=+\-@\t\r]/.test(v)) v = "'" + v;
            return '"' + v.replace(/"/g, '""') + '"';
        }

        function domainsCsv(list) {
            const rows = [['Domain Name', 'Provider', 'Purchase Date', 'Renewal Date', 'Purchase Price', 'Renewal Price', 'Auto Renew']];
            list.forEach(d => rows.push([
                d.name, d.provider,
                (d.purchaseDate || '').split('T')[0], (d.renewalDate || '').split('T')[0],
                Number(d.purchasePrice || 0).toFixed(2), Number(d.renewalPrice || 0).toFixed(2),
                d.autoRenew ? 'Yes' : 'No'
            ]));
            return rows.map(r => r.map(csvField).join(',')).join('\r\n') + '\r\n';
        }

        /** Everything in the vault except stored registrar passwords. */
        function exportJson() {
            const data = {
                exportedAt: new Date().toISOString(),
                account: { email: currentUser.email, plan: currentUser.plan },
                domains: domains.map(d => ({
                    name: d.name, provider: d.provider,
                    purchaseDate: (d.purchaseDate || '').split('T')[0] || null,
                    renewalDate: (d.renewalDate || '').split('T')[0] || null,
                    purchasePrice: Number(d.purchasePrice || 0), renewalPrice: Number(d.renewalPrice || 0),
                    autoRenew: !!d.autoRenew
                })),
                providers: providers.map(p => ({
                    name: p.name, url: p.url, username: p.user, userId: p.uid, hasStoredPassword: !!p.hasPassword
                })),
                settings: {
                    username: settings.username, language: settings.language, theme: settings.theme,
                    reminders: settings.reminders
                },
                purchases: purchases
            };
            downloadFile(`domain_vault_${todayStamp()}.json`, 'application/json', JSON.stringify(data, null, 2));
        }

        function renderPurchases() {
            const list = document.getElementById('purchasesList');
            if (!list) return;
            const t = translations[settings.language] || translations.en;
            if (purchases.length === 0 && subscriptions.length === 0) {
                list.innerHTML = `<p class="field-hint" style="font-size:0.9em;">${t.noPurchases}</p>`;
                return;
            }
            const day = (iso) => String(iso || '').slice(0, 10);
            const subRows = subscriptions.map(sub => {
                const until = day(sub.paidUntil);
                const state = sub.status === 'active'
                    ? (until ? `renews automatically · paid until ${until}` : 'active')
                    : sub.status === 'cancelled'
                        ? (until ? `cancelled · active until ${until}` : 'cancelled')
                        : 'ended';
                const price = sub.amount === null || sub.amount === undefined ? '' : ` · ${Number(sub.amount).toFixed(2)} ${sub.currency || ''} / year`;
                return `<div class="purchase-row">
                    <span><strong>${escapeHTML(sub.plan || '')}</strong>${escapeHTML(price)}</span>
                    <span>${escapeHTML(state)}</span>
                </div>`;
            }).join('');
            const manage = subscriptions.some(sub => sub.status === 'active')
                ? `<p class="field-hint" style="margin: 6px 0 14px;"><a href="${PAYPAL_MANAGE_URL}" target="_blank" rel="noopener" style="color: var(--primary);">${t.manageSubscription}</a></p>`
                : '';
            const payRows = purchases.map(p => {
                const amount = p.amount === null || p.amount === undefined ? '' : `${Number(p.amount).toFixed(2)} ${p.currency || ''}`;
                const status = String(p.status || '');
                const kind = p.kind === 'subscription' ? 'yearly payment' : 'lifetime';
                return `<div class="purchase-row">
                    <span><strong>${escapeHTML(p.plan || '')}</strong> · ${escapeHTML(kind)} · ${escapeHTML(day(p.created_at))}</span>
                    <span>${escapeHTML(amount)} · ${escapeHTML(status.charAt(0).toUpperCase() + status.slice(1))}</span>
                </div>`;
            }).join('');
            list.innerHTML = subRows + manage + payRows;
        }

        // --- DISMISSED NOTIFICATIONS ---
        // Kept per account in this browser, keyed by domain and renewal date,
        // so a dismissed alert stays dismissed until the next renewal cycle.

        function dismissedKey() { return `dv.dismissed.${currentUser ? currentUser.id : ''}`; }

        function loadDismissed() {
            try { return JSON.parse(localStorage.getItem(dismissedKey())) || []; } catch (e) { return []; }
        }

        function rememberDismissed(key) {
            if (!key) return;
            const live = new Set(domains.map(d => `${d.id}|${(d.renewalDate || '').split('T')[0]}`));
            const list = loadDismissed().filter(k => live.has(k));
            list.push(key);
            try { localStorage.setItem(dismissedKey(), JSON.stringify(list)); } catch (e) { /* storage blocked */ }
        }

        const compactDate = (iso) => String(iso || '').split('T')[0].replace(/-/g, '');

        /** All-day events end on the following day (the end date is exclusive). */
        const nextDayCompact = (iso) => {
            const d = new Date(String(iso).split('T')[0] + 'T00:00:00Z');
            d.setUTCDate(d.getUTCDate() + 1);
            return d.toISOString().slice(0, 10).replace(/-/g, '');
        };

        const generateGoogleCalendarLink = (d) => {
            const text = encodeURIComponent(`Renew domain: ${d.name}`);
            const details = encodeURIComponent(`Reminder to renew ${d.name} with ${d.provider}. Annual cost: $${d.renewalPrice}.`);
            return `https://calendar.google.com/calendar/render?action=TEMPLATE&text=${text}&dates=${compactDate(d.renewalDate)}/${nextDayCompact(d.renewalDate)}&details=${details}`;
        };

        /** RFC 5545 text value. */
        const icsText = (v) => String(v).replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');

        /** Fold lines longer than 75 octets, as calendar files require. */
        const icsFold = (line) => {
            const enc = new TextEncoder();
            if (enc.encode(line).length <= 75) return line;
            const parts = [];
            let cur = '', size = 0;
            for (const ch of line) {
                const n = enc.encode(ch).length;
                if (size + n > (parts.length ? 74 : 75)) { parts.push(cur); cur = ''; size = 0; }
                cur += ch; size += n;
            }
            parts.push(cur);
            return parts.join('\r\n ');
        };

        const generateICal = (arr, bulk = false) => {
            const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
            const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Bebell Digital Solutions//Domain Vault//EN', 'CALSCALE:GREGORIAN'];
            arr.forEach(d => {
                if (!d || !d.renewalDate) return;
                lines.push(
                    'BEGIN:VEVENT',
                    `UID:${d.id}-${compactDate(d.renewalDate)}@domain-vault`,
                    `DTSTAMP:${stamp}`,
                    `DTSTART;VALUE=DATE:${compactDate(d.renewalDate)}`,
                    `DTEND;VALUE=DATE:${nextDayCompact(d.renewalDate)}`,
                    `SUMMARY:${icsText('Renew domain: ' + d.name)}`,
                    `DESCRIPTION:${icsText(`Reminder to renew ${d.name} with ${d.provider}. Annual cost: $${d.renewalPrice}.`)}`,
                    'END:VEVENT');
            });
            lines.push('END:VCALENDAR');
            downloadFile(bulk ? 'all_renewals.ics' : `renew_${arr[0].name}.ics`, 'text/calendar', lines.map(icsFold).join('\r\n') + '\r\n');
        };

        // Utility
        document.getElementById('removePicBtn').addEventListener('click', async () => {
            settings.profilePicture = '';
            applySettings();
            if(currentUser) await persist('saveSettings', { settings }, "Profile picture removed.", false);
        });
        document.getElementById('uploadPicBtn').addEventListener('click', () => document.getElementById('profilePicUpload').click());
        document.getElementById('profilePicUpload').addEventListener('change', () => document.getElementById('settingsProfileForm').dispatchEvent(new Event('submit')));





