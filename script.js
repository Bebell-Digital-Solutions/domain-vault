
        /* ==========================================================================
           JAVASCRIPT LOGIC
           ========================================================================== */


        const PLAN_LIMITS = {
            'Personal': 5,
            'Start-up': 20,
            'Business': 50,
            'Agency': Infinity
        };

        // --- DEFINITIVE PAYMENT CONFIGURATION ---
        const PAYMENT_CONFIG = {
            provider: 'paypal', // Options: 'paypal' or 'zylvie'
            urls: {
                paypal: {
                    'Start-up': 'https://www.paypal.com/cgi-bin/webscr?cmd=_s-xclick&hosted_button_id=YOUR_STARTUP_ID',
                    'Business': 'https://www.paypal.com/cgi-bin/webscr?cmd=_s-xclick&hosted_button_id=YOUR_BUSINESS_ID',
                    'Agency': 'https://www.paypal.com/cgi-bin/webscr?cmd=_s-xclick&hosted_button_id=YOUR_AGENCY_ID'
                },
                zylvie: {
                    'Start-up': 'https://zylvie.com/your-store/p/domain-vault?variant=startup',
                    'Business': 'https://zylvie.com/your-store/p/domain-vault?variant=business',
                    'Agency': 'https://zylvie.com/your-store/p/domain-vault?variant=agency'
                }
            }
        };

        // --- TRANSLATION DATA ---
        const translations = {
            en: {
                domainManager: "Domain Vault", brandName: "DOMAIN VAULT", brandSlogan: "Secure Domain Manager",
                dashboard: "Dashboard", allDomains: "All Domains", domainProviders: "Domain Providers", toolsResources: "Tools & Resources",
                calendar: "Calendar", notifications: "Notifications", settings: "Settings", searchPlaceholder: "Search domains...",
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
                upgradeTitle: "Upgrade Required", upgradeDesc: "Upgrade your account to add more domains and unlock premium features.", contactAdmin: "Contact Admin to Upgrade", maybeLater: "Maybe Later",
                reports: "Reports", applyFilter: "Apply Filter", emailReport: "Email Report", downloadCsv: "Download CSV", startDate: "Start Date", endDate: "End Date",
                currentPlan: "Your Current Plan:", selectNewPlan: "Select New Plan"
            },
            es: {
                domainManager: "Domain Vault", brandName: "DOMAIN VAULT", brandSlogan: "Gestor Seguro de Dominios",
                dashboard: "Tablero", allDomains: "Todos los Dominios", domainProviders: "Proveedores", toolsResources: "Herramientas",
                calendar: "Calendario", notifications: "Notificaciones", settings: "Configuración", searchPlaceholder: "Buscar dominios...",
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
                upgradeTitle: "Actualización Requerida", upgradeDesc: "Actualice su cuenta para agregar más dominios y desbloquear funciones premium.", contactAdmin: "Contactar Admin para Actualizar", maybeLater: "Quizás Más Tarde",
                reports: "Reportes", applyFilter: "Aplicar Filtro", emailReport: "Enviar por Correo", downloadCsv: "Descargar CSV", startDate: "Fecha de Inicio", endDate: "Fecha de Fin",
                currentPlan: "Tu Plan Actual:", selectNewPlan: "Seleccionar Nuevo Plan"
            }
        };

        // --- DATA ARRAYS FOR TOOLS & RECOMMENDATIONS ---
        const recommendedProvidersData = [
            { name: "Namecheap", desc: "Best for budget domains", rating: 5, url: "https://namecheap.com/", icon: "tag", tags: ["domains"] },
            { name: "Porkbun", desc: "Great UI & pricing", rating: 5, url: "https://porkbun.com/", icon: "piggy-bank", tags: ["domains"] },
            { name: "Hostinger", desc: "Domain + Hosting bundles", rating: 4.5, url: "https://hostinger.com/", icon: "server", tags: ["domains", "hosting"] }
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
        let settings = { username: 'User', language: 'en', theme: 'orange' };
        let expensesChart = null;
        let isLoginMode = true;
        let currentCalendarDate = new Date();
        let currentToolFilter = 'all';
        let currentReportData = [];

        const colorThemes = {
            orange: { primary: '#ff5011' }, cyan: { primary: '#17A2B8' }, green: { primary: '#51cf66' },
            purple: { primary: '#9370DB' }, pink: { primary: '#DF1783' }
        };

        // --- MATRIX BACKGROUND LOGIC ---
        let matrixInterval = null;
        let matrixThemeColor = '#ff5011';

        function initMatrix() {
            const canvas = document.getElementById('matrixCanvas');
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

            // Start Matrix Effect
            initMatrix();

            // Restore a previous session, if there is one. The old build logged
            // you out on every refresh.
            window.DomainVaultAPI.restore().then(function (user) {
                if (!user) return;
                currentUser = user;
                document.getElementById('auth-overlay').style.display = 'none';
                if (matrixInterval) clearInterval(matrixInterval);
                loadDashboardData();
            });

            // Setup Auth Overlay UI
            document.getElementById('tab-login').addEventListener('click', () => switchAuthMode(true));
            document.getElementById('tab-register').addEventListener('click', () => switchAuthMode(false));
            document.getElementById('authSubmitBtn').addEventListener('click', handleAuthSubmit);
            document.getElementById('logoutBtn').addEventListener('click', handleLogout);

            // Setup Plan Badge Click Listener
            document.getElementById('upgradePlanBtn').addEventListener('click', () => {
                document.getElementById('upgradeCurrentPlan').textContent = currentUser?.plan || 'Personal';
                document.getElementById('upgradeModal').style.display = 'flex';
            });

            // Modular Checkout Button Logic
            document.getElementById('proceedToCheckoutBtn').addEventListener('click', () => {
                const selectedPlan = document.getElementById('upgradePlanSelect').value;
                const provider = PAYMENT_CONFIG.provider;
                const baseUrl = PAYMENT_CONFIG.urls[provider][selectedPlan];
                
                if(!baseUrl || baseUrl.includes('YOUR_')) return showToast("Payment URL not fully configured.", "danger");

                let checkoutUrl = baseUrl;
                
                // Dynamically append the user's email based on the provider's API standard
                if (provider === 'paypal') {
                    checkoutUrl += `&custom=${encodeURIComponent(currentUser.email)}`;
                } else if (provider === 'zylvie') {
                    const separator = baseUrl.includes('?') ? '&' : '?';
                    checkoutUrl += `${separator}email=${encodeURIComponent(currentUser.email)}`;
                }
                
                // Redirect user to the active payment gateway
                window.location.href = checkoutUrl;
            });

            // Modals & Navigation
            document.getElementById('addDomainBtn').addEventListener('click', () => {
                const limit = PLAN_LIMITS[currentUser?.plan || 'Personal'] || 5;
                if (domains.length >= limit) {
                    document.getElementById('upgradeCurrentPlan').textContent = currentUser?.plan || 'Personal';
                    document.getElementById('upgradeModal').style.display = 'flex';
                    return;
                }
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
                if (currentUser) await apiCall('saveSettings', { settings: settings, email: currentUser.email });
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
                let csv = "Domain Name,Provider,Purchase Date,Renewal Date,Purchase Price,Renewal Price,Auto Renew\n";
                currentReportData.forEach(d => {
                    const pd = d.purchaseDate ? d.purchaseDate.split('T')[0] : '';
                    const rd = d.renewalDate ? d.renewalDate.split('T')[0] : '';
                    csv += `"${d.name}","${d.provider}",${pd},${rd},${d.purchasePrice},${d.renewalPrice},${d.autoRenew}\n`;
                });
                const blob = new Blob([csv], { type: 'text/csv' });
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url;
                a.download = `domain_report_${new Date().toISOString().split('T')[0]}.csv`;
                document.body.appendChild(a);
                a.click();
                document.body.removeChild(a);
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
            document.getElementById('syncGCalBtn').addEventListener('click', () => showToast('Google Calendar bulk sync coming soon.', 'warning'));

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
        
        function switchAuthMode(login) {
            isLoginMode = login;
            document.getElementById('tab-login').classList.toggle('active', login);
            document.getElementById('tab-register').classList.toggle('active', !login);
            document.getElementById('registerFields').style.display = login ? 'none' : 'block';
            document.getElementById('authSubmitBtn').textContent = login ? 'Log In' : 'Register Account';
            document.getElementById('authMessage').style.display = 'none';
        }

        // Transport lives in backend/web/api.js. It attaches the signed JWT,
        // refreshes it when it expires, and keeps the session across reloads.
        // Identity is taken from that token server-side, so the email these
        // call sites still pass is ignored.
        async function apiCall(action, payload = {}) {
            if (!window.DomainVaultAPI) {
                showToast("backend/web/api.js did not load.", "danger");
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
            const email = document.getElementById('authEmail').value;
            const pass = document.getElementById('authPassword').value;
            const phone = document.getElementById('authPhone').value;
            const msgEl = document.getElementById('authMessage');

            if(!email || !pass) return showToast("Email and password required.", "warning");

            msgEl.style.display = 'block';
            msgEl.style.color = 'var(--text-muted)';
            msgEl.textContent = 'Processing...';
            document.getElementById('authSubmitBtn').disabled = true;

            try {
                if (isLoginMode) {
                    const res = await apiCall('loginUser', { email: email, password: pass }); // Updated to loginUser
                    document.getElementById('authSubmitBtn').disabled = false;
                    if(res.success) {
                        currentUser = res.user;
                        document.getElementById('auth-overlay').style.display = 'none';
                        if(matrixInterval) clearInterval(matrixInterval); // Optimize performance
                        loadDashboardData();
                    } else {
                        msgEl.style.color = 'var(--danger)';
                        msgEl.textContent = res.message;
                    }
                } else {
                    const location = await fetchLocation();
                    const res = await apiCall('registerUser', { email: email, password: pass, phone: phone, location: location }); // Updated to registerUser
                    document.getElementById('authSubmitBtn').disabled = false;
                    if(res.success) {
                        msgEl.style.color = 'var(--success)';
                        msgEl.textContent = res.message;
                        setTimeout(() => switchAuthMode(true), 3000);
                    } else {
                        msgEl.style.color = 'var(--danger)';
                        msgEl.textContent = res.message;
                    }
                }
            } catch (err) {
                document.getElementById('authSubmitBtn').disabled = false;
                msgEl.style.color = 'var(--danger)';
                msgEl.textContent = "Connection error.";
            }
        }

        function handleLogout() {
            window.DomainVaultAPI.signOut();
            currentUser = null;
            document.getElementById('auth-overlay').style.display = 'flex';
            document.getElementById('authForm').reset();
            document.getElementById('authMessage').style.display = 'none';
            domains = []; providers = []; notifications = [];
            initMatrix(); // Restart Matrix rain
        }

        function loadDashboardData() {
            document.getElementById('userPlanBadgeText').textContent = currentUser.plan.toUpperCase();
            const limit = PLAN_LIMITS[currentUser.plan] || 5;
            document.getElementById('stat-domain-limit').textContent = `/ ${limit === Infinity ? '∞' : limit}`;

            apiCall('getUserData', { email: currentUser.email }).then(data => {
                // Check if data exists directly, as the backend returns the raw arrays without a "success" flag
                if(data && !data.error) {
                    domains = data.domains || [];
                    providers = data.providers || [];
                    if(data.settings) settings = data.settings;
                    else settings.username = currentUser.email.split('@')[0];
                }
                
                applySettings();
                setLanguage(settings.language);
                setActivePage('dashboard');
                renderAll();
            }).catch(err => {
                showToast("Failed to load dashboard data.", "danger");
            });
        }

        function showToast(message, type = 'success') {
            const toast = document.getElementById('toast');
            toast.textContent = message;
            toast.style.borderLeftColor = `var(--${type})`;
            toast.classList.add('show');
            setTimeout(() => toast.classList.remove('show'), 3000);
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
            if (settings.theme === 'custom' && settings.customColor) {
                document.documentElement.style.setProperty('--primary', settings.customColor);
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
                    avatar.style.backgroundImage = `url(${settings.profilePicture})`;
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
                    settings.theme = key; settings.customColor = null;
                    applySettings();
                    if(expensesChart) updateStats();
                    if(currentUser) await apiCall('saveSettings', { settings: settings, email: currentUser.email });
                });
                colorPalette.appendChild(swatch);
            });
            if (settings.customColor) document.getElementById('customColorPicker').value = settings.customColor;
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
            document.getElementById('stat-total-domains').innerHTML = `${domains.length} <span id="stat-domain-limit" style="font-size: 14px; color:var(--text-muted);">/ ${PLAN_LIMITS[currentUser?.plan || 'Personal'] === Infinity ? '∞' : PLAN_LIMITS[currentUser?.plan || 'Personal']}</span>`;
            
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

            expiringDomains.forEach(d => {
                if (!notifIds.includes(String(d.id))) {
                    const rdStr = d.renewalDate.split('T')[0];
                    const diff = Math.ceil((new Date(rdStr+'T00:00:00') - now) / 86400000);
                    let msg = diff <= 0 ? `<strong>${d.name}</strong> ${translations[lang].statusExpired}!` : `<strong>${d.name}</strong> ${translations[lang].statusExpiringIn.replace('{days}', diff)}`;
                    const n = { id: Date.now()+d.id, domainId: String(d.id), message: msg, type: diff <= 0 ? 'expired' : 'expiring' };
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

        const renderPopUpNotifications = (arr) => {
            const c = document.getElementById('persistent-notifications-container');
            c.innerHTML = ''; 
            arr.forEach(n => {
                const el = document.createElement('div');
                el.className = `persistent-notification ${n.type}`;
                el.innerHTML = `<p>${n.message}</p><button class="notification-dismiss-btn">&times;</button>`;
                el.querySelector('button').addEventListener('click', () => el.remove());
                c.appendChild(el);
            });
        };

        const updateNotificationBadge = () => {
            document.querySelectorAll('.notification-badge').forEach(b => b.textContent = notifications.length > 0 ? notifications.length : '');
        };

        // --- EXTERNAL APIs ---
        
        async function fetchWhoisData() {
            const domain = document.getElementById('domainName').value.trim();
            const status = document.getElementById('whoisStatus');
            const lang = settings.language;
            if (!domain) return showToast('Please enter a domain name first.', 'warning');
            
            status.style.display = 'block'; status.style.color = 'var(--text-muted)';
            status.textContent = translations[lang].fetching;
            
            try {
                const res = await fetch(`https://networkcalc.com/api/dns/whois/${domain}`);
                const data = await res.json();
                if (data.status === 'OK' && Object.keys(data.whois).length > 0) {
                    if (data.whois.creation_date) document.getElementById('purchaseDate').value = new Date(data.whois.creation_date).toISOString().substring(0, 10);
                    if (data.whois.expiry_date) document.getElementById('renewalDate').value = new Date(data.whois.expiry_date).toISOString().substring(0, 10);
                    if (data.whois.registrar) {
                        const sel = document.getElementById('domainProvider');
                        const rName = data.whois.registrar.toLowerCase();
                        let match = Array.from(sel.options).find(o => o.value && rName.includes(o.value.toLowerCase()));
                        if(match) sel.value = match.value;
                        else {
                            sel.value = 'other';
                            document.getElementById('otherProviderGroup').style.display = 'block';
                            document.getElementById('otherProvider').value = data.whois.registrar;
                        }
                    }
                    status.style.color = 'var(--success)'; status.textContent = translations[lang].whoisSuccess;
                } else {
                    status.style.color = 'var(--danger)'; status.textContent = translations[lang].whoisError;
                }
            } catch(e) {
                status.style.color = 'var(--danger)'; status.textContent = translations[lang].whoisError;
            }
        }

        async function fetchDnsRecords(domain) {
            document.getElementById('dnsDomainLabel').textContent = domain;
            document.getElementById('dnsModal').style.display = 'flex';
            document.getElementById('dnsTableWrapper').style.display = 'none';
            document.getElementById('dnsError').style.display = 'none';
            document.getElementById('dnsLoading').style.display = 'block';
            
            try {
                const types = ['A', 'AAAA', 'MX', 'TXT', 'CNAME', 'NS'];
                const results = await Promise.all(types.map(t => fetch(`https://dns.google/resolve?name=${domain}&type=${t}`).then(r => r.json())));
                
                document.getElementById('dnsLoading').style.display = 'none';
                let answers = [];
                results.forEach(d => { if(d.Answer) answers = answers.concat(d.Answer); });
                
                if (answers.length > 0) {
                    const tbody = document.getElementById('dnsTableBody');
                    tbody.innerHTML = '';
                    const map = { 1: 'A', 2: 'NS', 5: 'CNAME', 15: 'MX', 16: 'TXT', 28: 'AAAA' };
                    answers.sort((a, b) => a.type - b.type).forEach(r => {
                        tbody.innerHTML += `<tr><td><span class="dns-badge">${map[r.type]||'Type '+r.type}</span></td><td style="word-break: break-all;">${escapeHTML(r.data)}</td></tr>`;
                    });
                    document.getElementById('dnsTableWrapper').style.display = 'block';
                } else {
                    document.getElementById('dnsError').style.display = 'block';
                    document.getElementById('dnsError').textContent = translations[settings.language].noDnsFound;
                }
            } catch(e) {
                document.getElementById('dnsLoading').style.display = 'none';
                document.getElementById('dnsError').style.display = 'block';
                document.getElementById('dnsError').textContent = "Error connecting to DNS API.";
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
                document.getElementById('providerUid').value = data.uid || '';
            } else if(id === 'credentialsModal') {
                m.querySelector('#credentialsModalTitle').textContent = `${data.name} ${translations[lang].providerCredentials}`;
                document.getElementById('credUser').textContent = data.user || 'Not set';
                document.getElementById('credPass').textContent = data.hasPassword ? '••••••••' : 'Not set';
                document.getElementById('credUid').textContent = data.uid || 'Not set';
            }
            m.style.display = 'flex';
        }

        function closeModal(m) {
            m.style.display = 'none';
            if (m.querySelector('form')) m.querySelector('form').reset();
            if (m.id === 'domainModal') document.getElementById('otherProviderGroup').style.display = 'none';
        }
        
        async function saveDomain(e) {
            e.preventDefault();
            let pName = document.getElementById('domainProvider').value;
            let isNewProvider = false;

            if (pName === 'other') {
                const oName = document.getElementById('otherProvider').value.trim();
                if (oName && !providers.some(p => p.name.toLowerCase() === oName.toLowerCase())) {
                    providers.push({ id: (window.crypto && crypto.randomUUID ? crypto.randomUUID() : 'prov_' + Date.now()), name: oName, url: '', user: '', pass: '', uid: '' });
                    isNewProvider = true;
                }
                pName = oName;
            }

            const id = document.getElementById('domainId').value || (window.crypto && crypto.randomUUID ? crypto.randomUUID() : 'dom_' + Date.now());
            const domain = {
                id: id,
                name: document.getElementById('domainName').value,
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
            showToast("Syncing with Google Sheets...", "warning");
            
            try {
                await apiCall('saveDomains', { domains: domains, email: currentUser.email });
                if (isNewProvider) {
                    await apiCall('saveProviders', { providers: providers, email: currentUser.email });
                    renderProviders();
                }
                showToast("Saved to Database!", "success");
            } catch (err) {
                showToast("Failed to save to database.", "danger");
            }
        }

        async function deleteDomain(id) {
            if(confirm("Delete this domain?")) {
                domains = domains.filter(d => String(d.id) !== String(id));
                renderAll();
                try {
                    await apiCall('saveDomains', { domains: domains, email: currentUser.email });
                    showToast("Domain deleted.");
                } catch (err) {
                    showToast("Failed to sync deletion.", "danger");
                }
            }
        }

        async function saveProvider(e) {
            e.preventDefault();
            const id = document.getElementById('providerId').value || (window.crypto && crypto.randomUUID ? crypto.randomUUID() : 'prov_' + Date.now());
            const newName = document.getElementById('providerName').value;
            const provider = {
                id: id, name: newName,
                url: document.getElementById('providerUrl').value,
                user: document.getElementById('providerUser').value,
                pass: document.getElementById('providerPass').value,
                uid: document.getElementById('providerUid').value
            };

            const idx = providers.findIndex(p => String(p.id) === String(id));
            let nameChanged = false;
            if (idx > -1) {
                const oldName = providers[idx].name;
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
            
            try {
                await apiCall('saveProviders', { providers: providers, email: currentUser.email });
                if(nameChanged) await apiCall('saveDomains', { domains: domains, email: currentUser.email });
                showToast("Provider saved.");
            } catch (err) {
                showToast("Failed to save provider.", "danger");
            }
        }

        async function deleteProvider(id) {
            const p = providers.find(x => String(x.id) === String(id));
            if(domains.some(d => d.provider === p.name)) return showToast('Cannot delete a provider with active domains.', 'danger');
            
            if(confirm(`Delete ${p.name}?`)) {
                providers = providers.filter(x => String(x.id) !== String(id));
                renderProviders();
                try {
                    await apiCall('saveProviders', { providers: providers, email: currentUser.email });
                    showToast("Provider deleted.");
                } catch (err) {
                    showToast("Failed to sync deletion.", "danger");
                }
            }
        }

        async function saveSettings(e) {
            e.preventDefault();
            settings.username = document.getElementById('settingUsername').value;
            
            // Handle Profile Picture
            const fileInput = document.getElementById('profilePicUpload');
            if (fileInput.files.length > 0) {
                const reader = new FileReader();
                reader.onload = async function(event) {
                    settings.profilePicture = event.target.result;
                    applySettings();
                    try {
                        await apiCall('saveSettings', { settings: settings, email: currentUser.email });
                        showToast("Settings and Picture saved.");
                    } catch (err) { showToast("Failed to save settings.", "danger"); }
                }
                reader.readAsDataURL(fileInput.files[0]);
            } else {
                applySettings();
                try {
                    await apiCall('saveSettings', { settings: settings, email: currentUser.email });
                    showToast("Settings saved.");
                } catch (err) { showToast("Failed to save settings.", "danger"); }
            }
        }

        const generateGoogleCalendarLink = (d) => {
            const text = encodeURIComponent(`Renew domain: ${d.name}`);
            const date = new Date(d.renewalDate).toISOString().slice(0, 10).replace(/-/g, '');
            const details = encodeURIComponent(`Reminder to renew ${d.name} with ${d.provider}. Annual cost: $${d.renewalPrice}.`);
            return `https://www.google.com/calendar/render?action=TEMPLATE&text=${text}&dates=${date}/${date}&details=${details}`;
        };

        const generateICal = (arr, bulk = false) => {
            let ical = `BEGIN:VCALENDAR\nVERSION:2.0\n`;
            arr.forEach(d => {
                if(!d.renewalDate) return;
                const rdStr = d.renewalDate.split('T')[0];
                const date = new Date(rdStr + 'T00:00:00').toISOString().slice(0, 10).replace(/-/g, '');
                ical += `BEGIN:VEVENT\nDTSTART;VALUE=DATE:${date}\nDTEND;VALUE=DATE:${date}\nSUMMARY:Renew domain: ${d.name}\nDESCRIPTION:Reminder to renew ${d.name} with ${d.provider}. Annual cost: $${d.renewalPrice}.\nEND:VEVENT\n`;
            });
            ical += `END:VCALENDAR`;
            const blob = new Blob([ical], { type: 'text/calendar' });
            const a = document.createElement('a');
            a.href = URL.createObjectURL(blob);
            a.download = bulk ? 'all_renewals.ics' : `renew_${arr[0].name}.ics`;
            document.body.appendChild(a); a.click(); document.body.removeChild(a);
        };

        // Utility
        document.getElementById('removePicBtn').addEventListener('click', async () => {
            settings.profilePicture = null;
            applySettings();
            if(currentUser) await apiCall('saveSettings', { settings: settings, email: currentUser.email });
            showToast("Profile picture removed.");
        });
        document.getElementById('uploadPicBtn').addEventListener('click', () => document.getElementById('profilePicUpload').click());
        document.getElementById('profilePicUpload').addEventListener('change', () => document.getElementById('settingsProfileForm').dispatchEvent(new Event('submit')));





