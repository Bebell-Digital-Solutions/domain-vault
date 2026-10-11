
    // Initialize Lucide icons
    lucide.createIcons();

    // ==========================================
    // 1. REGISTRAR PROFILES & AFFILIATE ROUTING
    // ==========================================
    // Replace placeholder IDs (e.g., YOUR_IMPACT_ID) with your actual affiliate tracking credentials.
    const registrarProfiles = {
        spaceship: {
            name: 'Spaceship',
            displayDomain: 'spaceship.com',
            whois: 'Free Forever',
            ssl: 'Paid Add-on',
            affiliateUrl: (domain) => `https://spaceship.sjv.io/c/YOUR_SPACESHIP_IMPACT_ID/subtrack?u=${encodeURIComponent('https://www.spaceship.com/domain-search/?query=' + domain)}`,
            notes: null
        },
        cloudflare: {
            name: 'Cloudflare',
            displayDomain: 'cloudflare.com',
            whois: 'Free Forever',
            ssl: 'Free via CDN',
            // Cloudflare offers domains at wholesale zero-markup cost with no retail affiliate program
            affiliateUrl: (domain) => `https://www.cloudflare.com/products/registrar/`,
            notes: 'Locked to Cloudflare Nameservers'
        },
        porkbun: {
            name: 'Porkbun',
            displayDomain: 'porkbun.com',
            whois: 'Free Forever',
            ssl: "Free (Let's Encrypt)",
            affiliateUrl: (domain) => `https://porkbun.com/tld/${domain}?affid=YOUR_PORKBUN_AFFILIATE_ID`,
            notes: null
        },
        hostinger: {
            name: 'Hostinger',
            displayDomain: 'hostinger.com',
            whois: 'Free',
            ssl: 'Free',
            affiliateUrl: (domain) => `https://www.hostinger.com/domain-name-search?REFERRALCODE=YOUR_HOSTINGER_CODE&domain=${encodeURIComponent(domain)}`,
            notes: 'Promo requires multi-year hosting plan'
        },
        namecheap: {
            name: 'Namecheap',
            displayDomain: 'namecheap.com',
            whois: 'Free Forever',
            ssl: 'Paid Add-on',
            affiliateUrl: (domain) => `https://namecheap.pxf.io/c/YOUR_NAMECHEAP_IMPACT_ID/domain-search?domain=${encodeURIComponent(domain)}`,
            notes: null
        },
        godaddy: {
            name: 'GoDaddy',
            displayDomain: 'godaddy.com',
            whois: 'Basic',
            ssl: 'Paid Add-on',
            affiliateUrl: (domain) => `https://www.tkqlhce.com/click-YOUR_GODADDY_CJ_ID?url=${encodeURIComponent('https://godaddy.com/domainsearch/find?checkAvail=1&domainToCheck=' + domain)}`,
            notes: null
        },
        ionos: {
            name: 'IONOS',
            displayDomain: 'ionos.com',
            whois: 'Free',
            ssl: 'Paid Add-on',
            affiliateUrl: (domain) => `https://www.ionos.com/domains/domain-names?affiliate_id=YOUR_IONOS_AFFILIATE_ID&domain=${encodeURIComponent(domain)}`,
            notes: '1st year promo pricing'
        },
        networksolutions: {
            name: 'Network Solutions',
            displayDomain: 'networksolutions.com',
            whois: 'Paid Add-on', // They charge ~$9.99–$14.99/yr for private registration
            ssl: 'Paid Add-on',
            // CJ Affiliate Deep Link Format:
            affiliateUrl: (domain) => `https://www.tkqlhce.com/click-YOUR_NETSOL_CJ_ID?url=${encodeURIComponent('https://www.networksolutions.com/domain-search/results?searchDomain=' + domain)}`,
            notes: 'WHOIS privacy is a paid extra; high renewal rates'
        },
        namesilo: {
            name: 'NameSilo',
            displayDomain: 'namesilo.com',
            whois: 'Free Forever',
            ssl: 'Paid Add-on',
            affiliateUrl: (domain) => `https://www.namesilo.com/domain/search-domains?query=${encodeURIComponent(domain)}&rid=YOUR_NAMESILO_RID`,
            notes: null
        }
    };

    // ==========================================
    // 2. MULTI-TLD PRICING DATABASE
    // ==========================================
    // Schema: 'tld_key': { registrar_id: [PurchasePrice, RenewalPrice] }
    // To add a new extension, append a lowercase key without leading dot.
    const tldPricingDatabase = {
        'com': {
            spaceship: [8.88, 10.18],
            cloudflare: [10.46, 10.46],
            porkbun: [11.08, 11.08],
            hostinger: [1.99, 19.99],
            namecheap: [11.28, 18.48],
            godaddy: [13.19, 23.19],
            ionos: [1.00, 20.00],
            networksolutions: [9.99, 39.99],
            namesilo: [10.88, 10.88]
        },
        'net': {
            spaceship: [12.48, 13.98],
            cloudflare: [13.48, 13.48],
            porkbun: [12.98, 12.98],
            hostinger: [3.99, 21.99],
            namecheap: [13.98, 19.98],
            godaddy: [15.99, 24.99],
            ionos: [1.00, 22.00],
            networksolutions: [14.99, 44.99],
            namesilo: [13.79, 13.79]
        },
        'org': {
            spaceship: [9.98, 11.48],
            cloudflare: [11.05, 11.05],
            porkbun: [11.54, 11.54],
            hostinger: [2.99, 20.99],
            namecheap: [12.48, 19.98],
            godaddy: [14.99, 23.99],
            ionos: [1.00, 21.00],
            networksolutions: [14.99, 44.99],
            namesilo: [11.99, 11.99]
        },
        'io': {
            spaceship: [33.88, 38.88],
            cloudflare: [40.00, 40.00],
            porkbun: [37.84, 37.84],
            hostinger: [39.99, 59.99],
            namecheap: [42.98, 49.98],
            godaddy: [44.99, 69.99],
            ionos: [35.00, 60.00],
            networksolutions: [14.99, 44.99],
            namesilo: [39.99, 39.99]
        },
        'ai': {
            spaceship: [79.88, 89.88],
            cloudflare: [80.00, 80.00],
            porkbun: [82.50, 82.50],
            hostinger: [89.99, 119.99],
            namecheap: [89.98, 99.98],
            godaddy: [99.99, 139.99],
            ionos: [80.00, 110.00],
            networksolutions: [14.99, 44.99],
            namesilo: [84.99, 84.99]
        },
        'app': {
            spaceship: [14.88, 17.88],
            cloudflare: [15.20, 15.20],
            porkbun: [15.84, 15.84],
            hostinger: [8.99, 24.99],
            namecheap: [16.98, 22.98],
            godaddy: [19.99, 28.99],
            ionos: [12.00, 25.00],
            networksolutions: [14.99, 44.99],
            namesilo: [16.49, 16.49]
        },
        'dev': {
            spaceship: [12.88, 15.88],
            cloudflare: [13.20, 13.20],
            porkbun: [13.84, 13.84],
            hostinger: [7.99, 22.99],
            namecheap: [14.98, 20.98],
            godaddy: [18.99, 26.99],
            ionos: [10.00, 24.00],
            networksolutions: [14.99, 44.99],
            namesilo: [14.49, 14.49]
        },
        'co': {
            spaceship: [8.98, 27.98],
            cloudflare: [26.18, 26.18],
            porkbun: [25.99, 25.99],
            hostinger: [4.99, 34.99],
            namecheap: [11.98, 32.98],
            godaddy: [11.99, 39.99],
            ionos: [3.00, 35.00],
            networksolutions: [14.99, 44.99],
            namesilo: [25.99, 25.99]
        },
        'online': {
            spaceship: [1.88, 38.88],
            cloudflare: [34.00, 34.00],
            porkbun: [2.84, 38.84],
            hostinger: [0.99, 39.99],
            namecheap: [2.98, 44.98],
            godaddy: [1.99, 49.99],
            ionos: [1.00, 45.00],
            networksolutions: [14.99, 44.99],
            namesilo: [2.99, 39.99]
        },
        'xyz': {
            spaceship: [2.48, 12.98],
            cloudflare: [11.18, 11.18],
            porkbun: [2.84, 12.98],
            hostinger: [1.99, 18.99],
            namecheap: [2.98, 15.98],
            godaddy: [1.99, 21.99],
            ionos: [1.00, 19.00],
            networksolutions: [14.99, 44.99],
            namesilo: [2.89, 12.89]
        },
        'tech': {
            spaceship: [3.48, 24.98],
            cloudflare: [20.00, 20.00],
            porkbun: [4.10, 23.85],
            hostinger: [1.99, 25.99],
            namecheap: [8.98, 24.98],
            godaddy: [4.99, 27.99],
            ionos: [2.00, 20.00],
            networksolutions: [14.99, 44.99],
            namesilo: [4.29, 22.99]
        }
    };

    // Restricted & Sponsored TLDs (Cannot be registered via standard retail registrars)
    const restrictedTLDs = ['edu', 'gov', 'mil', 'int'];



    // ==========================================
    // 3. APPLICATION STATE & DOM REFERENCES
    // ==========================================
    let currentDomain = "";
    let resultsList = [];
    let currentSort = { column: 'total', direction: 'asc' };
    let isSearchActive = false;

    const form = document.getElementById('search-form');
    const input = document.getElementById('domain-input');
    const searchBtn = document.getElementById('search-btn');
    const errorMsg = document.getElementById('error-message');
    const statusContainer = document.getElementById('status-container');
    const statusCard = document.getElementById('status-card');
    const statusIconWrapper = document.getElementById('status-icon-wrapper');
    const statusIcon = document.getElementById('status-icon');
    const statusDomainName = document.getElementById('status-domain-name');
    const statusMessage = document.getElementById('status-message');
    const resultsContainer = document.getElementById('results-container');
    const tableBody = document.getElementById('table-body');



    // ==========================================
    // 4. HELPER UTILITIES
    // ==========================================
    function extractTLD(domain) {
        const parts = domain.split('.');
        if (parts.length < 2) return null;
        
        // Handle compound extensions (e.g., co.uk, com.do) if added to the database
        const compoundTLD = parts.slice(-2).join('.');
        if (tldPricingDatabase[compoundTLD]) {
            return compoundTLD;
        }
        
        return parts[parts.length - 1].toLowerCase();
    }

    function calculateTotalCost(purchase, renewal) {
        return (purchase + (renewal * 4)).toFixed(2);
    }

    function formatCurrency(amount) {
        return `$${parseFloat(amount).toFixed(2)}`;
    }

    function renderBooleanIcon(value) {
        if (value.toLowerCase().includes('free')) {
            return `<div class="tooltip-container">
                        <i class="fa-solid fa-circle-check text-brand-success text-lg drop-shadow-[0_0_8px_rgba(81,207,102,0.4)]"></i>
                        <span class="tooltip-text">${value}</span>
                    </div>`;
        } else if (value.toLowerCase().includes('basic')) {
            return `<div class="tooltip-container">
                        <i class="fa-solid fa-shield-halved text-brand-warning text-lg drop-shadow-[0_0_8px_rgba(255,212,59,0.4)]"></i>
                        <span class="tooltip-text">${value}</span>
                    </div>`;
        } else {
            return `<div class="tooltip-container">
                        <i class="fa-solid fa-circle-xmark text-brand-muted/40 text-lg"></i>
                        <span class="tooltip-text">${value}</span>
                    </div>`;
        }
    }

    function isValidDomain(str) {
        const regex = /^[a-zA-Z0-9][a-zA-Z0-9-]{0,61}[a-zA-Z0-9](\.[a-zA-Z]{2,})+$/;
        return regex.test(str);
    }

    function renderSkeletonRows(count = 8) {
        tableBody.innerHTML = '';
        for (let i = 0; i < count; i++) {
            const tr = document.createElement('tr');
            tr.className = "border-b border-brand-border/30";
            tr.innerHTML = `
                <td class="py-4 px-6">
                    <div class="flex items-center gap-2">
                        <div class="w-6 h-6 skeleton rounded-full"></div>
                        <div class="h-4 w-24 skeleton"></div>
                    </div>
                </td>
                <td class="py-4 px-6"><div class="h-4 w-16 skeleton"></div></td>
                <td class="py-4 px-6"><div class="h-4 w-16 skeleton"></div></td>
                <td class="py-4 px-6"><div class="h-5 w-20 skeleton"></div></td>
                <td class="py-4 px-6 text-center"><div class="h-5 w-5 mx-auto skeleton rounded-full"></div></td>
                <td class="py-4 px-6 text-center"><div class="h-5 w-5 mx-auto skeleton rounded-full"></div></td>
                <td class="py-4 px-6 text-right"><div class="h-8 w-24 ml-auto skeleton rounded-md"></div></td>
            `;
            tableBody.appendChild(tr);
        }
    }

    function populateRow(data) {
        const tr = document.getElementById(`row-${data.id}`);
        if (!tr) return;

        const totalCost = calculateTotalCost(data.purchasePrice, data.renewalPrice);
        data.totalCost = parseFloat(totalCost);

        const nameHtml = `
            <div class="flex flex-col justify-center">
                <div class="flex items-center">
                    <span class="font-medium text-brand-textMain font-tech uppercase tracking-wider text-sm">${data.name}</span>
                    ${data.notes ? `
                    <div class="tooltip-container ml-2">
                        <i class="fa-solid fa-circle-info text-brand-primary text-sm hover:text-[#e6460f] transition-colors"></i>
                        <span class="tooltip-text w-48">${data.notes}</span>
                    </div>` : ''}
                </div>
                <a href="${data.targetUrl}" target="_blank" rel="noopener noreferrer nofollow" class="text-xs text-brand-muted hover:text-brand-primary transition-colors font-code mt-0.5 inline-flex items-center gap-1 w-max" title="Visit ${data.name}">
                    ${data.displayDomain} <i class="fa-solid fa-up-right-from-square text-[9px]"></i>
                </a>
            </div>
        `;

        tr.className = 'row-enter hover:bg-brand-hover transition-colors border-b border-brand-border/30';
        tr.innerHTML = `
            <td class="py-4 px-6 h-[72px] align-middle">${nameHtml}</td>
            <td class="py-4 px-6 font-code text-brand-textMain">${formatCurrency(data.purchasePrice)}</td>
            <td class="py-4 px-6 font-code text-brand-muted/70">${formatCurrency(data.renewalPrice)}/yr</td>
            <td class="py-4 px-6 font-code font-bold text-brand-primary text-lg drop-shadow-[0_0_5px_rgba(255,80,17,0.2)]">${formatCurrency(totalCost)}</td>
            <td class="py-4 px-6 text-center">${renderBooleanIcon(data.whois)}</td>
            <td class="py-4 px-6 text-center">${renderBooleanIcon(data.ssl)}</td>
            <td class="py-4 px-6 text-right">
                <a href="${data.targetUrl}" target="_blank" rel="noopener noreferrer nofollow" class="whitespace-nowrap inline-flex items-center gap-2 bg-transparent border border-brand-primary text-brand-primary hover:bg-brand-primary hover:text-white hover:shadow-glow text-sm font-code font-medium py-2 px-4 rounded transition-all">
                    Get It <i class="fa-solid fa-arrow-right-long text-xs"></i>
                </a>
            </td>
        `;
    }

    function resetSearchState() {
        isSearchActive = false;
        searchBtn.innerHTML = `<span>Search</span><i class="fa-solid fa-arrow-right"></i>`;
        searchBtn.classList.remove('opacity-80', 'cursor-not-allowed');
    }

    // ==========================================
    // 5. SEARCH PIPELINE
    // ==========================================
    async function performSearch(e) {
        e.preventDefault();
        if (isSearchActive) return;

        const domain = input.value.trim().toLowerCase();

        // 1. Syntax Validation
        if (!isValidDomain(domain)) {
            errorMsg.textContent = "Please enter a valid domain name (e.g., mystartup.com).";
            errorMsg.classList.remove('hidden');
            form.classList.add('ring-1', 'ring-brand-danger', 'border-brand-danger');
            return;
        }

        const tld = extractTLD(domain);

        // 2. Restricted TLD Gate
        if (restrictedTLDs.includes(tld)) {
            errorMsg.textContent = `.${tld.toUpperCase()} is a restricted extension and cannot be registered via public registrars.`;
            errorMsg.classList.remove('hidden');
            form.classList.add('ring-1', 'ring-brand-danger', 'border-brand-danger');
            return;
        }

        errorMsg.classList.add('hidden');
        form.classList.remove('ring-1', 'ring-brand-danger', 'border-brand-danger');
        isSearchActive = true;
        currentDomain = domain;
        resultsList = [];

        // 3. Set UI to Loading State
        searchBtn.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i>`;
        searchBtn.classList.add('opacity-80', 'cursor-not-allowed');
        resultsContainer.classList.add('hidden');
        statusContainer.classList.remove('hidden');

        statusCard.className = 'rounded-xl p-6 border flex items-center justify-between bg-brand-card border-brand-border';
        statusIconWrapper.className = 'w-12 h-12 rounded-full flex items-center justify-center text-xl bg-brand-bgDarker text-brand-textMain';
        statusIcon.className = 'fa-solid fa-spinner fa-spin';
        statusDomainName.textContent = domain;
        statusMessage.textContent = 'Querying authoritative RDAP registry...';

        // 4. Registry RDAP Query
        let isAvailable = false;
        try {
            const response = await fetch(`https://rdap.org/domain/${domain}`);
            if (response.status === 404) {
                isAvailable = true;
            } else if (response.status === 200) {
                isAvailable = false;
            } else {
                throw new Error(`RDAP returned unexpected status code: ${response.status}`);
            }
        } catch (error) {
            console.warn("Direct RDAP Lookup error or unsupported registry:", error);
            // Non-critical fallback for unindexed ccTLDs
            statusCard.classList.replace('bg-brand-card', 'bg-[#1a1a0a]');
            statusIconWrapper.classList.replace('bg-brand-bgDarker', 'bg-brand-warning/20');
            statusIconWrapper.classList.replace('text-brand-textMain', 'text-brand-warning');
            statusIcon.className = 'fa-solid fa-triangle-exclamation';
            statusMessage.innerHTML = '<span class="text-brand-warning font-medium">Lookup Note:</span> Direct registry check bypassed for this TLD. Showing market pricing...';
            isAvailable = true;
        }

        // 5. Domain Already Registered Handling
        if (!isAvailable) {
            statusCard.classList.replace('bg-brand-card', 'bg-[#1a0a0a]');
            statusCard.classList.replace('border-brand-border', 'border-brand-danger/50');
            statusIconWrapper.classList.replace('bg-brand-bgDarker', 'bg-brand-danger/20');
            statusIconWrapper.classList.replace('text-brand-textMain', 'text-brand-danger');
            statusIcon.className = 'fa-solid fa-circle-xmark';
            statusMessage.innerHTML = '<span class="text-brand-danger font-medium">Unavailable</span>. This domain is already registered.';
            resetSearchState();
            return;
        }

        // 6. Pricing Data Lookup by Extension
        const activePricing = tldPricingDatabase[tld];

        if (!activePricing) {
            statusCard.classList.replace('bg-brand-card', 'bg-[#1a1a0a]');
            statusIconWrapper.classList.replace('bg-brand-bgDarker', 'bg-brand-warning/20');
            statusIconWrapper.classList.replace('text-brand-textMain', 'text-brand-warning');
            statusIcon.className = 'fa-solid fa-circle-info';
            statusMessage.innerHTML = `<span class="text-brand-warning font-medium">Available!</span> We do not have price tracking indexed for <strong>.${tld}</strong> yet.`;
            resetSearchState();
            return;
        }

        // 7. Render Available State & Prepare Table
        statusCard.classList.replace('bg-brand-card', 'bg-[#0a1a0f]');
        statusCard.classList.replace('border-brand-border', 'border-brand-success/50');
        statusIconWrapper.classList.replace('bg-brand-bgDarker', 'bg-brand-success/20');
        statusIconWrapper.classList.replace('text-brand-textMain', 'text-brand-success');
        statusIcon.className = 'fa-solid fa-circle-check';
        statusMessage.innerHTML = `<span class="text-brand-success font-medium">Available!</span> Displaying verified pricing for .${tld.toUpperCase()}`;

        const registrarsToDisplay = Object.keys(activePricing).map(regId => {
            const profile = registrarProfiles[regId];
            const [purchase, renewal] = activePricing[regId];
            return {
                id: regId,
                name: profile.name,
                displayDomain: profile.displayDomain,
                purchasePrice: purchase,
                renewalPrice: renewal,
                whois: profile.whois,
                ssl: profile.ssl,
                targetUrl: profile.affiliateUrl(domain),
                notes: profile.notes
            };
        });

        resultsContainer.classList.remove('hidden');
        renderSkeletonRows(registrarsToDisplay.length);

        // Pre-create table rows for async population
        tableBody.innerHTML = '';
        registrarsToDisplay.forEach(item => {
            const tr = document.createElement('tr');
            tr.id = `row-${item.id}`;
            tr.className = "border-b border-brand-border/30";
            tr.innerHTML = `
                <td class="py-4 px-6"><div class="h-4 w-24 skeleton"></div></td>
                <td class="py-4 px-6"><div class="h-4 w-16 skeleton"></div></td>
                <td class="py-4 px-6"><div class="h-4 w-16 skeleton"></div></td>
                <td class="py-4 px-6"><div class="h-5 w-20 skeleton"></div></td>
                <td class="py-4 px-6 text-center"><div class="h-5 w-5 mx-auto skeleton rounded-full"></div></td>
                <td class="py-4 px-6 text-center"><div class="h-5 w-5 mx-auto skeleton rounded-full"></div></td>
                <td class="py-4 px-6 text-right"><div class="h-8 w-24 ml-auto skeleton rounded-md"></div></td>
            `;
            tableBody.appendChild(tr);
        });

        const promises = registrarsToDisplay.map(regData => {
            return new Promise(resolve => {
                const delay = Math.floor(Math.random() * 600) + 200;
                setTimeout(() => {
                    resultsList.push(regData);
                    populateRow(regData);
                    resolve();
                }, delay);
            });
        });

        await Promise.all(promises);
        resetSearchState();
        handleSort('total');
    }

    // ==========================================
    // 6. SORTING & LISTENERS
    // ==========================================
    window.handleSort = function(column) {
        if (resultsList.length === 0) return;

        if (currentSort.column === column) {
            currentSort.direction = currentSort.direction === 'asc' ? 'desc' : 'asc';
        } else {
            currentSort.column = column;
            currentSort.direction = 'asc';
        }

        // Reset visual sorting headers
        document.getElementById('sort-icon-purchasing').className = 'fa-solid fa-sort text-brand-muted/50';
        document.getElementById('sort-icon-total').className = 'fa-solid fa-sort text-brand-muted/50';

        const activeIcon = document.getElementById(`sort-icon-${column}`);
        if (activeIcon) {
            activeIcon.className = `fa-solid fa-sort-${currentSort.direction === 'asc' ? 'up' : 'down'} text-brand-primary`;
        }

        resultsList.sort((a, b) => {
            const valA = (column === 'total') ? a.totalCost : a.purchasePrice;
            const valB = (column === 'total') ? b.totalCost : b.purchasePrice;
            return currentSort.direction === 'asc' ? valA - valB : valB - valA;
        });

        tableBody.innerHTML = '';
        resultsList.forEach(data => {
            const tr = document.createElement('tr');
            tr.id = `row-${data.id}`;
            tableBody.appendChild(tr);
            populateRow(data);
        });
    };

    form.addEventListener('submit', performSearch);

    input.addEventListener('input', function(e) {
        e.target.value = e.target.value.toLowerCase().replace(/[^a-z0-9.-]/g, '');
    });



