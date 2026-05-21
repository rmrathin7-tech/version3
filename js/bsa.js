import { auth, db } from "./firebase.js";
import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { doc, getDoc, collection, getDocs, setDoc, updateDoc, serverTimestamp, deleteDoc } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

// ── GLOBALS & STATE ──
let currentProjectId = null;
let currentProjectName = null;
let currentBsaId = null;
let bsaDocData = null;

let statements = [];
let masterTransactions = [];
let isEditorMode = false;
let currentFilters = { search: '', source: 'all', category: 'all', type: 'all', period: 'all', flagged: false };

const PAGE_SIZE = 100;
let currentPage = 0;
let lastFilteredResults = [];

const chartInstances = {};

let saveTimer = null;
function debouncedFirebaseSave() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(async () => {
        try {
            for (let stmt of statements) {
                await updateDoc(doc(db, "projects", currentProjectId, "bsa", currentBsaId, "statements", stmt.id), {
                    data: stmt.data, updatedAt: serverTimestamp()
                });
            }
            showToast("Auto-saved.", "success");
        } catch(e) { /* silent */ }
    }, 2000);
}

const HF_API_URL = "https://rathin-07-bankstatementextractorv1.hf.space/analyze-bank-statement";

function debounce(fn, delay) {
    let timer;
    return (...args) => { clearTimeout(timer); timer = setTimeout(() => fn(...args), delay); };
}

function normalizeCategory(cat) {
    if (!cat) return 'Others';
    const map = {
        'Transfer':             'Transfers',
        'transfer':             'Transfers',
        'Income / Receipt':     'Income',
        'income / receipt':     'Income',
        'Ecom/Online':          'Ecom / Online',
        'Ecom/ Online':         'Ecom / Online',
        'Loan & EMI':           'Loans & EMI',
        'Tax&Govt':             'Tax & Govt',
        'BankCharges':          'Bank Charges',
        'Food&Dining':          'Food & Dining',
        'Travel':               'Travel & Transport',
        'Transport':            'Travel & Transport',
        'Medical':              'Healthcare & Medical',
        'Health':               'Healthcare & Medical',
        'Healthcare':           'Healthcare & Medical',
    };
    return map[cat] || cat;
}

// ── INIT ──
onAuthStateChanged(auth, async (user) => {
    if (!user) { window.location.href = "login.html"; return; }

    const params = new URLSearchParams(window.location.search);
    currentProjectId = params.get('project');
    currentProjectName = params.get('name');
    currentBsaId = params.get('bsa');

    if (!currentProjectId || !currentBsaId) {
        alert("Invalid URL parameters.");
        window.location.href = "module-hub.html";
        return;
    }

    document.getElementById('project-name').textContent = decodeURIComponent(currentProjectName);
    document.getElementById('back-btn').addEventListener('click', () => {
        window.location.href = `module-hub.html?project=${currentProjectId}&name=${currentProjectName}`;
    });

    setupTabs();
    setupFilters();
    await loadBsaData();
});

// ── 1. FIREBASE: LOAD ──
async function loadBsaData() {
    try {
        const docRef = doc(db, "projects", currentProjectId, "bsa", currentBsaId);
        const snap = await getDoc(docRef);
        if (!snap.exists()) { alert("Record not found."); return; }
        bsaDocData = snap.data();

        const stmtsSnap = await getDocs(collection(db, "projects", currentProjectId, "bsa", currentBsaId, "statements"));
        statements = stmtsSnap.docs.map(d => ({ id: d.id, ...d.data() }));

        // Normalize all categories loaded from Firestore
        statements.forEach(stmt => {
            (stmt.data || []).forEach(t => {
                t.category = normalizeCategory(t.category);
            });
        });

        const initialLoader = document.getElementById('initial-loading-state');
        if (initialLoader) initialLoader.classList.add('hidden');

        if (statements.length > 0) {
            document.getElementById('empty-state').classList.add('hidden');
            const mainTabs = document.getElementById('main-tabs');
            mainTabs.classList.remove('hidden');
            mainTabs.style.display = '';

            document.getElementById('tab-transactions').classList.remove('hidden');
            document.getElementById('tab-transactions').classList.add('active');
            document.getElementById('export-excel-btn').classList.remove('hidden');
            document.getElementById('export-pdf-btn').classList.remove('hidden');
            document.getElementById('export-csv-btn').classList.remove('hidden');
            document.getElementById('open-upload-modal-btn').classList.remove('hidden');
            rebuildMasterLedger();
        } else {
            const emptyState = document.getElementById('empty-state');
            emptyState.classList.remove('hidden');
            emptyState.style.display = '';
            document.getElementById('main-tabs').classList.add('hidden');
            document.getElementById('open-upload-modal-btn').classList.add('hidden');
        }
        renderStatementManager();
    } catch (err) {
        console.error("Load Error:", err);
        showToast("Failed to load data.", "error");
    }
}

// ── 2. UPLOAD & EXTRACT ──
const uploadModal = document.getElementById('upload-modal');
document.getElementById('empty-add-btn').addEventListener('click', () => uploadModal.classList.remove('hidden'));
document.getElementById('open-upload-modal-btn').addEventListener('click', () => uploadModal.classList.remove('hidden'));
document.getElementById('close-upload-modal').addEventListener('click', () => uploadModal.classList.add('hidden'));

const fileInput = document.getElementById('stmt-file-input');
document.getElementById('trigger-file-btn').addEventListener('click', () => fileInput.click());

fileInput.addEventListener('change', async (e) => {
    const file = e.target.files[0];
    const nameInput = document.getElementById('stmt-name-input').value.trim();
    if (!file) return;
    if (!nameInput) { alert("Please provide a Statement Name / Source first."); fileInput.value = ""; return; }

    document.getElementById('upload-ui').classList.add('hidden');
    document.getElementById('upload-loading').classList.remove('hidden');

    const formData = new FormData();
    formData.append("file", file);
try {
    const response = await fetch(HF_API_URL, { method: 'POST', body: formData });
    
    // ✅ Add this — log raw response before parsing
    const rawText = await response.text();
    console.log('Backend raw response:', rawText);  // check DevTools console
    
    if (!response.ok) throw new Error(`API Error ${response.status}: ${rawText}`);
    
    const result = JSON.parse(rawText);
    if (result.status === 'error') throw new Error(result.message);

const extraction = result.extractionresults || result;
let aiData = extraction.data || result.data || [];

// ✅ Only this — no duplicate let ob
let ob = parseFloat(result.opening_balance || extraction.opening_balance || 0);
if (aiData[0]?.date === 'Opening') {
    if (!ob) ob = parseFloat(aiData[0].balance) || 0;
    aiData = aiData.slice(1);
}

        aiData.forEach(t => {
            t.category = normalizeCategory(categorizeTransaction(t.description, t.credit, t.debit));
        });

        const CHUNK_SIZE = 1500;
        const totalChunks = Math.ceil(aiData.length / CHUNK_SIZE);

        for (let i = 0; i < totalChunks; i++) {
            const chunkData = aiData.slice(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE);
            const chunkOb = (i === 0) ? ob : 0;
            const chunkName = totalChunks > 1 ? `${nameInput} (Part ${i + 1})` : nameInput;
            const stmtId = `stmt_${crypto.randomUUID()}`;

            await setDoc(doc(db, "projects", currentProjectId, "bsa", currentBsaId, "statements", stmtId), {
                name: chunkName,
                openingBalance: chunkOb,
                isLocked: false,
                data: chunkData,
                createdAt: serverTimestamp()
            });
        }

        showToast(`Extracted ${aiData.length} transactions successfully!`, "success");
        uploadModal.classList.add('hidden');
        document.getElementById('upload-ui').classList.remove('hidden');
        document.getElementById('upload-loading').classList.add('hidden');
        document.getElementById('stmt-name-input').value = "";
        fileInput.value = "";
        await loadBsaData();

    } catch (err) {
        console.error(err);
        alert("Extraction Error: " + err.message);
        document.getElementById('upload-ui').classList.remove('hidden');
        document.getElementById('upload-loading').classList.add('hidden');
    }
});

document.getElementById('start-manual-btn').addEventListener('click', async () => {
    const nameInput = document.getElementById('stmt-name-input').value.trim() || "Manual Ledger";
    const stmtId = `stmt_${crypto.randomUUID()}`;
    await setDoc(doc(db, "projects", currentProjectId, "bsa", currentBsaId, "statements", stmtId), {
        name: nameInput, openingBalance: 0.0, isLocked: false, data: []
    });
    uploadModal.classList.add('hidden');
    await loadBsaData();
});

// ── 3. DATE PARSER ──
function parseDateStr(dateStr) {
    if (!dateStr) return new Date(0);
    const parts = dateStr.split(/[-/ ]/);
    if (parts.length >= 3) {
        if (parts[0].length === 4) return new Date(dateStr);
        return new Date(`${parts[1]} ${parts[0]}, ${parts[2]}`);
    }
    return new Date(0);
}

// ── 4. MASTER LEDGER ENGINE ──
function rebuildMasterLedger() {
    masterTransactions = [];

    statements.forEach(stmt => {
        (stmt.data || []).forEach((txn, idx) => {
            const parsed = parseDateStr(txn.date);
            const month = parsed.getTime() > 0
                ? `${parsed.toLocaleString('default', { month: 'short' })} ${parsed.getFullYear()}`
                : '';

            masterTransactions.push({
                ...txn,
                category: normalizeCategory(txn.category),
                id: `${stmt.id}_${idx}`,
                sourceId: stmt.id,
                sourceName: stmt.name,
                isDuplicate: false,
                isHidden: false,
                _date: parsed,
                _period: month,
                _searchIndex: [
                    txn.date || '',
                    txn.description || '',
                    String(txn.debit || ''),
                    String(txn.credit || ''),
                    txn.notes || ''
                ].join(' ').toLowerCase()
            });
        });
    });

    masterTransactions.sort((a, b) => a._date - b._date);

    let duplicatesFound = 0;
    for (let i = 0; i < masterTransactions.length; i++) {
        const cur = masterTransactions[i];
        if (cur.isHidden) continue;
        for (let j = i + 1; j < Math.min(i + 15, masterTransactions.length); j++) {
            const nxt = masterTransactions[j];
            if (nxt.isHidden || cur.sourceId === nxt.sourceId) continue;
            if (cur.date === nxt.date &&
                String(cur.debit) === String(nxt.debit) &&
                String(cur.credit) === String(nxt.credit)) {
                nxt.isDuplicate = true;
                duplicatesFound++;
            }
        }
    }

    const dedupeBtn = document.getElementById('toggle-dedupe-btn');
    if (dedupeBtn) {
        if (duplicatesFound > 0) {
            dedupeBtn.classList.remove('hidden');
            dedupeBtn.textContent = `⚠️ Resolve ${duplicatesFound} Duplicates`;
        } else {
            dedupeBtn.classList.add('hidden');
        }
    }

    const sortedStmts = [...statements].sort((a, b) => {
        const aDate = parseDateStr(a.data?.[0]?.date);
        const bDate = parseDateStr(b.data?.[0]?.date);
        return aDate - bDate;
    });
    let globalRunning = parseFloat(sortedStmts[0]?.openingBalance) || 0;

    let lastDate = null;
    let hasGap = false;

    masterTransactions.forEach(t => {
        if (t.isDuplicate || t.isHidden) return;
        globalRunning += (parseFloat(t.credit) || 0) - (parseFloat(t.debit) || 0);
        t.balance = globalRunning;
        if (lastDate && (t._date - lastDate) > 45 * 86400000) hasGap = true;
        lastDate = t._date;
    });

    const gapEl = document.getElementById('gap-warning');
    if (gapEl) gapEl.classList.toggle('hidden', !hasGap);

    updateSourceFilter();
    updatePeriodFilter();

    currentPage = 0;
    lastFilteredResults = applyFilters();
    renderPage();
    updateTableStatus();

    const summaryTab = document.querySelector('.bsa-tab[data-target="tab-summary"]');
    const analyticsTab = document.querySelector('.bsa-tab[data-target="tab-analytics"]');
    if (summaryTab?.classList.contains('active')) renderSummary();
    if (analyticsTab?.classList.contains('active')) renderAnalytics();
}

// ── 5. AUTO-CATEGORIZATION ──
function categorizeTransaction(desc, credit, debit) {
    const raw = (desc || '');
    const d = raw.toLowerCase();
    const isCredit = parseFloat(credit) > 0;
    const isDebit  = parseFloat(debit)  > 0;

    // ─── HELPER: word-boundary safe match ────────────────────────────────────
    // Prevents /salary- inside IMPS ref codes from matching
    const wb = (word) => new RegExp(`\\b${word}\\b`, 'i').test(raw);
    const has = (...words) => words.some(w => d.includes(w));
    const wbAny = (...words) => words.some(w => wb(w));

    // =========================================================================
    // 1. SALARIES
    // Salary RECEIVED (credit) → Salaries
    // Salary PAID (debit)      → Salaries (company paying staff — still Salaries)
    // =========================================================================
    if (
        wbAny('salary', 'sal', 'payroll', 'remuneration', 'wages', 'stipend', 'ctc') ||
        has('pay slip', 'payslip', 'salary credit', 'sal cr', 'sal paid',
            'monthly pay', 'staff pay', 'employee pay', 'staff salary',
            'salary transfer', 'salary payment', 'salary disburs',
            'wage credit', 'wage payment', 'basic pay',
            'salary for the month', 'monthly salary', 'net salary',
            'gross salary', 'take home', 'salary advance', 'advance salary',
            'hrms', 'hris', 'paymaster', 'pay order',
            // Indian payroll platforms
            'keka', 'darwinbox', 'greythr', 'sumopayroll', 'zimyo', 'factohr',
            '247hrnow', 'razorpayx payroll', 'open payroll',
            // Common IMPS/NEFT salary narration patterns
            '/salary ', '/salary-', 'salary/', '-salary', ' salary fo',
            'sal fo', 'sal adv', 'salaryfo', 'salcr')
    ) {
        return 'Salaries';
    }

    // =========================================================================
    // 2. RENT & LEASE
    // =========================================================================
    if (
        wbAny('rent', 'lease', 'tenancy', 'landlord', 'lessor', 'lessee') ||
        has('rental', 'rented', 'office rent', 'shop rent', 'house rent',
            'monthly rent', 'rent payment', 'rent paid', 'rent deposit',
            'security deposit', 'advance rent', 'premises rent',
            'building rent', 'commercial rent', 'warehouse rent',
            'coworking', 'co-working', 'serviced office',
            'property rent', 'flat rent', 'pg rent', 'hostel rent',
            'accommodation rent', 'room rent',
            'lease rental', 'lease payment', 'lease amount',
            'lease deposit', 'leave and licence', 'l&l')
    ) {
        return 'Rent';
    }

    // =========================================================================
    // 3. LOANS & EMI
    // =========================================================================
    if (
        wbAny('emi', 'loan', 'equated', 'repay', 'mortgage', 'overdraft') ||
        has('loan emi', 'home loan', 'car loan', 'vehicle loan', 'auto loan',
            'personal loan', 'business loan', 'education loan', 'gold loan',
            'two wheeler loan', 'bike loan', 'loan repayment', 'loan payment',
            'loan installment', 'loan instalment', 'loan deduction',
            'emi payment', 'emi debit', 'emi auto debit', 'emi bounce',
            'equated monthly', 'monthly instalment', 'installment paid',
            'principal repayment', 'interest repayment',
            'mortgage payment', 'mortgage emi',
            'nbfc', 'mfi', 'microfinance', 'sbl', 'msme loan',
            'working capital loan', 'term loan', 'cc limit', 'cash credit',
            'od repayment', 'overdraft repayment', 'line of credit',
            'loan account', 'loan a/c', 'loan no.',
            // Lender name patterns common in India
            'bajaj finance', 'bajaj finserv', 'hdfc home', 'lic housing',
            'pnb housing', 'indiabull', 'muthoot', 'manappuram',
            'fullerton', 'tata capital', 'l&t finance', 'aditya birla finance',
            'shriram finance', 'mahindra finance', 'cholamandalam',
            'credit fair', 'incred', 'lendingkart', 'flexiloans',
            'capital first', 'hdb financial', 'iifl finance', 'hero fincorp',
            'smfg india', 'piramal finance')
    ) {
        return 'Loans & EMI';
    }

    // =========================================================================
    // 4. INVESTMENTS
    // =========================================================================
    if (
        wbAny('invest', 'equity', 'dividend', 'debenture', 'portfolio',
              'brokerage', 'nav', 'sip', 'folio') ||
        has('mutual fund', 'mf purchase', 'mf redemption', 'mf switch',
            'fund purchase', 'fund redemption', 'fund transfer',
            'zerodha', 'groww', 'upstox', 'kuvera', 'coin by zerodha',
            'paytm money', 'icicidirect', 'hdfc securities', 'kotak securities',
            'axis securities', 'sbi securities', 'motilal oswal', 'angel broking',
            'angel one', 'sharekhan', '5paisa', 'dhan', 'fyers', 'mstock',
            'nse', 'bse', 'sensex', 'nifty', 'stock purchase', 'stock sale',
            'shares purchased', 'shares sold', 'ipo allotment', 'ipo application',
            'ipo refund', 'asba', 'rights issue', 'bonus shares',
            'nps', 'national pension', 'pension fund', 'ppf', 'elss',
            'public provident fund', 'sukanya', 'kvp', 'nsc', 'mis scheme',
            'government bond', 'g-sec', 'gsec', 'treasury bill', 't-bill',
            'rbi bond', 'sovereign gold bond', 'sgb', 'gold bond',
            'fd receipt', 'fixed deposit', 'fd opening', 'fd created',
            'rd opening', 'recurring deposit', 'fd maturity', 'rd maturity',
            'fd interest', 'rd interest',
            'arbitrage fund', 'liquid fund', 'debt fund', 'hybrid fund',
            'index fund', 'etf purchase', 'etf sale', 'nifty etf',
            'gold etf', 'reit', 'invit', 'smallcase', 'wealthdesk',
            'scripbox', 'fisdom', 'goalwise', 'orowealth',
            'dividend received', 'dividend credited', 'dividend payout',
            'int on fd', 'fd int', 'interest on deposit')
    ) {
        return 'Investments';
    }

    // =========================================================================
    // 5. TAX & GOVT
    // =========================================================================
    if (
        wbAny('gst', 'tds', 'tax', 'vat', 'cess', 'surcharge', 'customs',
              'excise', 'levy', 'penalty', 'fine') ||
        has('income tax', 'income-tax', 'professional tax', 'property tax',
            'corporate tax', 'advance tax', 'self assessment tax',
            'tds payment', 'tcs payment', 'tds deducted', 'tcs deducted',
            'gst payment', 'gst challan', 'gst return', 'igst', 'cgst', 'sgst',
            'service tax', 'swachh bharat', 'education cess',
            'municipality tax', 'municipal tax', 'local body tax',
            'stamp duty', 'registration fee', 'court fee', 'govt fee',
            'government fee', 'challan payment', 'e-challan', 'nsdl',
            'traces', 'itd', 'income tax department',
            'gst network', 'gstn', 'tin-nsdl', 'oltas',
            'esic', 'epf', 'provident fund', 'pf payment', 'pf deposit',
            'pf contribution', 'pf employer', 'gratuity fund',
            'pt challan', 'lwf', 'labour welfare fund',
            'traffic fine', 'parking fine', 'challaan',
            'parivahan', 'vahan', 'rto fee', 'driving licence fee',
            'passport fee', 'visa fee', 'immigration fee',
            'customs duty', 'import duty', 'export duty',
            'tolltax', 'toll tax', 'toll plaza', 'fastag recharge',
            'fastag', 'nhb', 'nhai toll',
            'eway bill', 'e-way bill', 'waybill',
            'state govt', 'central govt', 'district collector',
            'tehsildar', 'taluk office', 'panchayat tax',
            'bbmp', 'mcgm', 'mcd', 'bmc', 'kmc', 'cmda', 'dtcp',
            'water tax', 'drainage tax', 'sewerage tax',
            'pf admin charge', 'esic contribution')
    ) {
        return 'Tax & Govt';
    }

    // =========================================================================
    // 6. BANK CHARGES & FEES
    // =========================================================================
    if (
        wbAny('charge', 'charges', 'fee', 'fees', 'penalty') ||
        has('bank charge', 'bank fee', 'account charge', 'account fee',
            'service charge', 'service fee', 'annual fee', 'annual charge',
            'maintenance charge', 'maintenance fee', 'amt charge',
            'processing fee', 'processing charge', 'convenience fee',
            'transaction charge', 'transaction fee', 'platform fee',
            'cheque bounce', 'dishonour charge', 'ecs bounce', 'nach bounce',
            'stop payment charge', 'dd charge', 'draft charge',
            'chq return', 'cheque return', 'instrument return',
            'sms charge', 'sms alert', 'sms fee', 'sms charges',
            'debit card fee', 'credit card fee', 'atm charge',
            'cash handling', 'cash deposit charge', 'over limit',
            'late payment', 'overdue charge', 'interest charged',
            'finance charge', 'finance fee', 'forfeiture',
            'minimum balance charge', 'non-maintenance', 'non maintenance',
            'card issuance fee', 'card replacement fee', 'pin regeneration',
            'statement charge', 'duplicate statement',
            'locker charge', 'locker fee', 'locker rent',
            'forex markup', 'foreign transaction fee', 'cross currency',
            'swift charge', 'wire transfer fee', 'correspondent bank fee',
            'ach charge', 'nach charge', 'ecs charge', 'mandate charge',
            'gst on charge', 'gst on bank', 'gst on service',
            'penal interest', 'penal charge',
            'bank penalty', 'bank commission', 'commission charge',
            'brokerage charge', 'demat charge', 'dp charge', 'dp fees',
            'cms charges', 'outward clearing', 'return memo',
            'bounced cheque', 'bounce charge', 'dishonoured', 'dishonored',
            'interest debit', 'od interest', 'cc interest', 'loan interest')
    ) {
        return 'Bank Charges';
    }

    // =========================================================================
    // 7. UTILITIES
    // =========================================================================
    if (
        wbAny('electricity', 'broadband', 'internet', 'postpaid', 'prepaid',
              'dth', 'recharge', 'topup', 'gas', 'pipeline') ||
        has('utility', 'utilities', 'electricity bill', 'power bill',
            'electricity payment', 'eb payment', 'eb bill',
            'tneb', 'bescom', 'msedcl', 'tpddl', 'bses', 'cesc', 'apepdcl',
            'tsspdcl', 'jdvvnl', 'jvvnl', 'dhbvn', 'uhbvn', 'wbsedcl',
            'ksebl', 'kseb', 'gescom', 'hescom', 'mescom', 'cesc kolkata',
            'uppcl', 'mvvnl', 'puvvnl', 'dvvnl', 'purvanchal',
            'water bill', 'water board', 'water supply', 'water charge',
            'sewerage bill', 'drainage bill', 'bmwssb', 'cmwssb', 'mcgm water',
            'gas bill', 'piped gas', 'png bill', 'city gas', 'cng',
            'indane gas', 'hp gas', 'bharat gas', 'gas cylinder',
            'gas connection', 'gas subsidy', 'gas booking',
            'telecom', 'mobile bill', 'phone bill', 'landline bill',
            'broadband bill', 'internet bill', 'wifi bill', 'fiber bill',
            'jio', 'airtel', 'vodafone', 'vi postpaid', 'bsnl', 'mtnl',
            'act fibernet', 'hathway', 'tikona', 'nextra', 'den broadband',
            'mts', 'reliance jio', 'jio fiber', 'airtel fiber', 'you broadband',
            'mobile recharge', 'prepaid recharge', 'talk time', 'data pack',
            'dth recharge', 'tata sky', 'sun direct', 'dish tv', 'videocon d2h',
            'd2h recharge', 'airtel dth', 'tata play',
            'ott subscription', 'netflix', 'amazon prime', 'hotstar',
            'sony liv', 'zee5', 'voot', 'jiocinema', 'mxplayer',
            'spotify', 'apple music', 'youtube premium', 'gaana',
            'billdesk', 'bbps', 'bharat bill', 'billpay',
            'electricity recharge', 'eb recharge', 'prepaid meter')
    ) {
        return 'Utilities';
    }

    // =========================================================================
    // 8. FOOD & DINING
    // =========================================================================
    if (
        wbAny('restaurant', 'cafe', 'canteen', 'bakery', 'dhaba',
              'biryani', 'pizza', 'burger', 'sushi', 'hotel') ||
        has('food', 'dining', 'zomato', 'swiggy', 'dunzo food',
            'food delivery', 'meal', 'lunch', 'dinner', 'breakfast',
            'tiffin', 'mess bill', 'catering', 'snacks', 'beverages',
            'coffee', 'tea stall', 'juice', 'bar bill', 'pub',
            'dominos', 'dominoes', 'pizza hut', 'kfc', 'mcdonalds',
            "mcdonald's", 'burger king', 'subway', 'wendys', "wendy's",
            'haldiram', "haldiram's", 'barbeque nation', 'barbeque',
            'behrouz', 'box8', 'freshmenu', 'faasos', 'rebel foods',
            'oven story', 'mandarin', 'mainland china',
            'hotel bill', 'restaurant bill', 'food bill', 'mess fee',
            'canteen bill', 'canteen payment', 'kitchen expenses',
            'office food', 'team lunch', 'team dinner', 'client lunch',
            'food vendor', 'food expense', 'homemade food',
            'milk', 'dairy', 'amul', 'mother dairy', 'milkbasket',
            'country delight', 'doubtful supply',
            'grocery', 'groceries', 'supermarket', 'kirana',
            'bigbasket', 'blinkit', 'zepto', 'dunzo grocery',
            'jiomart', 'nature basket', 'star bazaar', 'dmart grocery',
            'more supermarket', 'reliance fresh', 'reliance smart',
            'spencers', "spencer's", 'spar', 'foodhall',
            'vegetables', 'fruits', 'provisions', 'provision store',
            'fish market', 'meat shop', 'chicken', 'mutton', 'eggs',
            'sweets', 'mithai', 'confectionery', 'cake shop',
            'bread', 'ration shop', 'fair price shop',
            'canara corner', 'tea board', 'coffee board')
    ) {
        return 'Food & Dining';
    }

    // =========================================================================
    // 9. ECOM / ONLINE SHOPPING
    // =========================================================================
    if (
        wbAny('amazon', 'flipkart', 'meesho', 'myntra', 'nykaa', 'ajio',
              'snapdeal', 'shopclues', 'indiamart', 'tradeindia') ||
        has('ecom', 'e-com', 'online shopping', 'online purchase',
            'online order', 'marketplace', 'e commerce', 'ecommerce',
            'amazon pay', 'amazon india', 'amazon prime',
            'flipkart pay', 'flipkart health', 'flipkart wholesale',
            'meesho seller', 'myntra order', 'nykaa fashion', 'ajio order',
            'tata cliq', 'reliance digital', 'croma', 'vijay sales',
            'one plus', 'oneplus', 'apple store', 'mi store', 'mi india',
            'samsung shop', 'boat lifestyle', 'noise store',
            'firstcry', 'hopscotch', 'baby oye',
            'pepperfry', 'urban ladder', 'ikea india', 'home centre',
            'fabindia', 'w for woman', 'biba', 'and designs', 'max fashion',
            'westside', 'pantaloons', 'lifestyle stores', 'shoppers stop',
            'central mall', 'globus', 'inorbit',
            'ebay', 'wish', 'shein', 'temu',
            // Payment gateways used in ecom
            'razorpay', 'razorpayx', 'cashfree', 'payu', 'instamojo',
            'ccavenue', 'payumoney', 'easebuzz', 'billdesk online',
            'airpay', 'payfort', 'juspay', 'paygate',
            // UPI collect / scan & pay retail
            'paytm', 'phonepe', 'gpay', 'google pay', 'bhim',
            'amazon pay upi', 'whatsapp pay', 'cred pay', 'slice pay',
            'mobikwik', 'freecharge', 'oxigen wallet', 'ola money',
            'airtel money', 'jio money', 'true caller pay',
            'paytm mall', 'paytm merchant', 'paytm online')
    ) {
        return 'Ecom / Online';
    }

    // =========================================================================
    // 10. CASH
    // =========================================================================
    if (
        has('atm', 'cash withdrawal', 'cash deposit', 'cash deposited',
            'cash handling', 'cash advance', 'cash back', 'cashback',
            'cash at pos', 'cash@pos', 'pos cash',
            'atm withdrawal', 'atm cash', 'atm wd', 'atm wd-',
            'cdm', 'cash deposit machine', 'currency chest',
            'cash in', 'cash out', 'currency exchange', 'forex cash',
            'traveller cheque', 'foreign currency', 'cash counter',
            'teller cash', 'bank cash', 'branch cash', 'counter cash',
            'petty cash', 'imprest cash',
            'cash transfer', 'cash pmt')
    ) {
        return 'Cash';
    }

    // =========================================================================
    // 11. TRAVEL & TRANSPORT
    // =========================================================================
    if (
        wbAny('flight', 'airline', 'airways', 'airport', 'railway',
              'trains', 'metro', 'cab', 'taxi', 'auto', 'bus', 'ferry',
              'petrol', 'diesel', 'fuel', 'toll') ||
        has('travel', 'transport', 'ticket', 'boarding pass',
            'flight ticket', 'air ticket', 'airfare', 'aviation',
            'indigo', 'air india', 'spicejet', 'vistara', 'goair', 'go first',
            'akasa air', 'star air', 'blue dart aviation',
            'irctc', 'indian railway', 'train ticket', 'rail ticket',
            'railway ticket', 'railway booking', 'platform ticket',
            'metro card', 'metro recharge', 'metro token',
            'dmrc', 'bmrc', 'cmrl', 'hyd metro', 'pune metro',
            'ola cab', 'ola ride', 'uber ride', 'uber cab', 'uber eats transport',
            'rapido', 'meru cab', 'savaari', 'zoom car', 'zoomcar',
            'drivezy', 'revv', 'self drive', 'car rental',
            'city cab', 'local cab', 'taxi fare', 'cab fare',
            'auto rickshaw', 'autorickshaw', 'three wheeler',
            'bike ride', 'bike taxi', 'rapido bike', 'yulu', 'bounce',
            'vogo', 'pedal', 'cycle rental',
            'bus ticket', 'volvo bus', 'sleeper bus', 'ksrtc', 'tnstc',
            'msrtc', 'upsrtc', 'rsrtc', 'gsrtc', 'best bus', 'bmtc',
            'redbus', 'abhibus', 'goibibo bus', 'makemytrip bus',
            'petrol', 'diesel', 'fuel', 'fuel charge', 'fuel expense',
            'petrol pump', 'fuel station', 'filling station',
            'hp petrol', 'iocl', 'bpcl', 'essar fuel', 'reliance petrol',
            'eeco petrol', 'eeco fuel', 'office vehicle', 'vehicle fuel',
            'vehicle maintenance', 'car service', 'car repair', 'car wash',
            'vehicle insurance', 'motor insurance', 'two wheeler insurance',
            'car insurance', 'insurance premium vehicle',
            'fastag', 'toll', 'toll charge', 'toll payment', 'highway toll',
            'nhai', 'expressway toll', 'toll plaza',
            'parking', 'parking charge', 'parking fee', 'car park',
            'goibibo', 'makemytrip', 'cleartrip', 'yatra', 'easemytrip',
            'ixigo', 'confirmtkt', 'via.com', 'paytm travel',
            'booking.com', 'oyo', 'oyo rooms', 'treebo', 'fabhotels',
            'airbnb', 'stayzilla', 'zostel', 'hosteller',
            'holiday inn', 'marriott', 'taj hotel', 'oberoi', 'itc hotel',
            'lemon tree', 'ibis hotel', 'novotel', 'hyatt',
            'tour package', 'holiday package', 'travel package',
            'travel agent', 'travel agency', 'tour operator',
            'luggage', 'baggage', 'moving charges', 'shifting charges',
            'courier', 'dtdc', 'bluedart', 'fedex', 'dhl', 'ups courier',
            'ekart', 'shadowfax', 'xpressbees', 'delhivery',
            'porter', 'dunzo delivery', 'ship rocket', 'shiprocket',
            'staff travel', 'staff bike', 'staff transport', 'staff ride',
            'staff vehicle', 'staff cab', 'conveyance', 'conveyance allowance',
            'travel allowance', 'ta da', 'ta/da', 'travel reimbursement',
            'fuel reimbursement', 'vehicle reimbursement')
    ) {
        return 'Travel & Transport';
    }

    // =========================================================================
    // 12. HEALTHCARE & MEDICAL
    // =========================================================================
    if (
        wbAny('hospital', 'clinic', 'pharmacy', 'medical', 'medicine',
              'doctor', 'physician', 'surgeon', 'nursing', 'nurse',
              'diagnostic', 'laboratory', 'lab', 'pathology', 'radiology',
              'dental', 'dentist', 'optical', 'optician') ||
        has('health', 'healthcare', 'healthcare payment', 'health insurance',
            'mediclaim', 'health cover', 'star health', 'care health',
            'niva bupa', 'max bupa', 'hdfc ergo health', 'bajaj health',
            'aditya birla health', 'religare health',
            'apollo', 'apollo pharmacy', 'apollo clinic', 'apollo hospital',
            'fortis', 'max hospital', 'medanta', 'aiims', 'aster hospital',
            'manipal hospital', 'narayana health', 'columbia asia',
            'wockhardt', 'lilavati', 'kokilaben', 'breach candy',
            'thyrocare', 'srl diagnostics', 'dr lal pathlabs', 'lal path',
            'metropolis', 'redcliffe labs', 'neuberg', 'healthians',
            'practo', '1mg', 'pharmeasy', 'netmeds', 'medlife',
            'tata 1mg', 'apollo pharmacy online', 'wellness forever',
            'medplus', 'jan aushadhi',
            'medicine', 'medicines', 'drugs', 'tablets', 'capsules',
            'injection', 'syrup', 'prescription', 'pharmacy bill',
            'chemist', 'medical store',
            'surgery', 'operation', 'consultation fee', 'doctor fee',
            'opd charge', 'ipd charge', 'ward charge', 'icu charge',
            'procedure charge', 'physiotherapy', 'physio', 'occupational therapy',
            'speech therapy', 'mental health', 'psychiatry', 'counselling',
            'dental treatment', 'dental bill', 'eye test', 'spectacles',
            'contact lens', 'hearing aid',
            'nursing staff', 'nursing payment', 'nurse payment',
            'carezy', 'home care', 'elder care', 'caretaker',
            'ambulance', 'blood bank', 'organ', 'transplant',
            'dialysis', 'chemotherapy', 'radiotherapy',
            'covid test', 'pcr test', 'antigen test', 'vaccination',
            'vaccine', 'immunization',
            'insurance claim', 'tpa', 'third party administrator',
            'reimbursement medical', 'medical reimbursement',
            'health camp', 'wellness', 'gym', 'fitness', 'yoga',
            'cult fit', 'cure fit', 'anytime fitness', 'gold gym',
            'fitness first', 'talwalkars', 'crossfit',
            'pt meds', 'patient', 'clinical payment')
    ) {
        return 'Healthcare & Medical';
    }

    // =========================================================================
    // 13. PROFESSIONAL FEES & SERVICES
    // =========================================================================
    if (
        wbAny('consult', 'consulting', 'consultancy', 'advisory',
              'legal', 'advocate', 'attorney', 'solicitor',
              'audit', 'auditor', 'chartered', 'ca fee',
              'architect', 'engineer', 'valuer', 'appraiser') ||
        has('professional fee', 'professional fees', 'professional charge',
            'professional service', 'professional payment',
            'consultancy fee', 'consulting fee', 'advisory fee',
            'retainer fee', 'retainer payment', 'retainership',
            'legal fee', 'legal charge', 'legal expense', 'legal service',
            'advocate fee', 'lawyer fee', 'attorney fee', 'court fee legal',
            'solicitor fee', 'notary fee', 'notary charge',
            'audit fee', 'audit charge', 'statutory audit', 'internal audit',
            'tax audit', 'gst audit', 'company secretary', 'cs fee',
            'ca fee', 'chartered accountant', 'accounting fee', 'bookkeeping',
            'management consulting', 'strategy consulting', 'it consulting',
            'hr consulting', 'recruitment fee', 'placement fee',
            'headhunting', 'staffing fee',
            'design fee', 'design charge', 'graphic design', 'web design',
            'ui ux', 'branding fee', 'logo design', 'creative fee',
            'content writing', 'copywriting', 'seo fee', 'digital marketing fee',
            'marketing agency', 'advertising agency', 'media agency',
            'pr agency', 'public relations',
            'it service', 'software service', 'tech service', 'dev service',
            'software development', 'app development', 'website development',
            'maintenance contract', 'amc', 'annual maintenance contract',
            'support contract', 'helpdesk service',
            'security service', 'security guard', 'guards payment',
            'housekeeping', 'cleaning service', 'facility management',
            'event management', 'photography fee', 'videography fee',
            'freelancer', 'freelance', 'contractor payment', 'contractor fee',
            'sub contractor', 'labour charge', 'labour payment',
            'fabrication', 'fabricat', 'manufacturing service',
            'printing', 'printing charge', 'stationery',
            'patent fee', 'trademark fee', 'ip fee', 'royalty',
            'license fee', 'licensing fee', 'subscription fee',
            'software license', 'saas fee', 'platform fee',
            'aws', 'azure', 'google cloud', 'gcp', 'digitalocean',
            'hosting fee', 'domain fee', 'server charge',
            'certification fee', 'training fee', 'course fee',
            'workshop fee', 'seminar fee', 'conference fee',
            'driver payment', 'driving staff', 'driver fee',
            'cooking staff', 'cook payment', 'chef fee',
            'attendant payment', 'helper payment',
            'physio payment', 'physiotherapy payment',
            'consultation payment', 'consulting payment')
    ) {
        return 'Professional Fees';
    }

    // =========================================================================
    // 14. INSURANCE
    // =========================================================================
    if (
        wbAny('insurance', 'premium', 'policy', 'insurer', 'insured',
              'endowment', 'annuity', 'actuarial') ||
        has('insurance premium', 'insurance payment', 'life insurance',
            'term insurance', 'term plan', 'ulip', 'whole life',
            'lic', 'lic premium', 'lic payment', 'lic policy',
            'hdfc life', 'icici pru', 'icici prudential', 'sbi life',
            'max life', 'bajaj allianz', 'reliance life', 'tata aia',
            'birla sun life', 'canara hsbc', 'pnb metlife', 'star union',
            'general insurance', 'non life insurance',
            'health insurance premium', 'mediclaim premium',
            'vehicle insurance premium', 'motor premium',
            'home insurance', 'property insurance', 'fire insurance',
            'marine insurance', 'cargo insurance', 'transit insurance',
            'travel insurance', 'trip insurance',
            'crop insurance', 'pmfby', 'pradhan mantri fasal bima',
            'group insurance', 'employee insurance',
            'new india assurance', 'oriental insurance', 'national insurance',
            'united india', 'hdfc ergo', 'bajaj allianz general',
            'reliance general', 'iffco tokio', 'cholamandalam general',
            'kotak general', 'tata aig', 'digit insurance',
            'acko', 'go digit', 'policy bazaar', 'coverfox',
            'insurance claim received', 'claim settlement',
            'surrender value', 'maturity amount insurance')
    ) {
        return 'Insurance';
    }

    // =========================================================================
    // 15. EDUCATION
    // =========================================================================
    if (
        wbAny('school', 'college', 'university', 'institute', 'academy',
              'tuition', 'coaching', 'course', 'exam', 'admission') ||
        has('education', 'educational', 'school fee', 'school fees',
            'college fee', 'college fees', 'tuition fee', 'tuition fees',
            'university fee', 'hostel fee', 'hostel fees',
            'library fee', 'lab fee', 'examination fee', 'exam fee',
            'admission fee', 'registration fee education',
            'course fee', 'training fee', 'coaching fee',
            'school bus fee', 'transport fee education',
            'uniform', 'books', 'stationery education', 'study material',
            'cbse', 'icse', 'igcse', 'ib board', 'state board',
            'iit', 'nit', 'bits', 'iim', 'mba fee',
            'byju', "byju's", 'vedantu', 'unacademy', 'toppr',
            'whitehat jr', 'great learning', 'upgrad', 'simplilearn',
            'coursera', 'udemy', 'edx', 'linkedin learning',
            'skill india', 'pmkvy', 'nsdc', 'polytechnic fee',
            'boarding school', 'day school', 'pre school', 'playschool',
            'montessori', 'kindergarten', 'nursery fee',
            'scholarship', 'stipend education', 'fellowship',
            'education loan emi', 'student loan')
    ) {
        return 'Education';
    }

    // =========================================================================
    // 16. INCOME / RECEIPTS (credits only)
    // =========================================================================
    if (isCredit) {
        if (
            wbAny('interest', 'dividend', 'refund', 'cashback', 'rebate',
                  'commission', 'incentive', 'bonus', 'reward') ||
            has('income', 'receipt', 'received', 'credited', 'proceeds',
                'sale proceeds', 'revenue', 'earning', 'earnings',
                'interest credit', 'interest received', 'interest income',
                'fd interest', 'rd interest', 'savings interest',
                'dividend credit', 'dividend received', 'dividend income',
                'refund', 'tax refund', 'income tax refund', 'gst refund',
                'itr refund', 'tds refund', 'excess tax', 'it refund',
                'cashback', 'reward points', 'loyalty points', 'cash reward',
                'sign up bonus', 'referral bonus', 'referral credit',
                'maturity amount', 'policy maturity', 'fd maturity credit',
                'insurance maturity', 'surrender value',
                'rental income', 'rent received', 'rent credit',
                'freelance income', 'consulting income', 'professional income',
                'business income', 'sales income', 'invoice payment',
                'payment received', 'client payment', 'customer payment',
                'advance received', 'deposit received',
                'loan disbursement', 'loan credited', 'loan sanctioned',
                'od limit', 'cc limit credited',
                'grant', 'subsidy', 'government subsidy',
                'pm kisan', 'pmay', 'scholarship received',
                'reimbursement credit', 'claim credit', 'insurance credit',
                'prize', 'award', 'winning',
                'festive bonus', 'performance bonus', 'annual bonus',
                'by transfer', 'credit by', 'cr by', 'cr-', 'credited by',
                'inward', 'inward remittance', 'inward neft', 'inward rtgs',
                'foreign inward', 'nostro', 'swift credit', 'wire credit')
        ) {
            return 'Income';
        }
    }

    // =========================================================================
    // 17. TRANSFERS (UPI / NEFT / IMPS / RTGS — generic)
    // Last resort before Others for any payment-method labelled transaction
    // =========================================================================
    if (
        has('upi', 'imps', 'neft', 'rtgs', 'ift', 'eft',
            'nach', 'ecs', 'ach', 'mandate',
            'fund transfer', 'bank transfer', 'online transfer',
            'intra bank transfer', 'inter bank transfer',
            'internal transfer', 'own account transfer',
            'to transfer', 'by transfer', 'to a/c', 'by a/c',
            'cr a/c', 'dr a/c', 'account transfer',
            'outward neft', 'outward rtgs', 'outward imps',
            'inward neft', 'inward rtgs', 'inward imps',
            'mobile transfer', 'internet transfer',
            'third party transfer', 'beneficiary transfer',
            'remittance', 'outward remittance', 'inward remittance',
            'wire transfer', 'telegraphic transfer', 'swift', 'fedwire',
            'international transfer', 'foreign transfer',
            'upi collect', 'upi pay', 'upi credit', 'upi debit',
            'bhim upi', 'upi autopay', 'upi mandate',
            'p2p', 'peer to peer', 'person to person',
            'self transfer', 'sweep in', 'sweep out',
            'wallet transfer', 'wallet load', 'wallet credit',
            'prepaid wallet', 'semi closed wallet')
    ) {
        return 'Transfers';
    }

    // =========================================================================
    // 18. OTHERS — fallback
    // =========================================================================
    return 'Others';
}
// ── 6. FILTER ENGINE ──
function applyFilters() {
    return masterTransactions.filter(txn => {
        if (txn.isDuplicate || txn.isHidden) return false;
        const s = currentFilters.search;
        if (s && !txn._searchIndex.includes(s)) return false;
        if (currentFilters.source !== 'all' && txn.sourceId !== currentFilters.source) return false;
        if (currentFilters.category !== 'all' && txn.category !== currentFilters.category) return false;
        if (currentFilters.type === 'debit' && !(parseFloat(txn.debit) > 0)) return false;
        if (currentFilters.type === 'credit' && !(parseFloat(txn.credit) > 0)) return false;
        if (currentFilters.period !== 'all' && txn._period !== currentFilters.period) return false;
        if (currentFilters.flagged && !txn.flagged) return false;
        return true;
    });
}

// ── 7. RENDER TRANSACTIONS ──
function renderTransactions() {
    currentPage = 0;
    lastFilteredResults = applyFilters();
    renderPage();
    updateTableStatus();
}


function renderPage() {
    const tbody = document.getElementById('ledger-tbody');
    const start = currentPage * PAGE_SIZE;
    const slice = lastFilteredResults.slice(start, start + PAGE_SIZE);

    const ALL_CATS = ["Salaries","Rent","Loans & EMI","Investments","Tax & Govt","Bank Charges",
        "Utilities","Food & Dining","Ecom / Online","Cash","Professional Fees","Income","Transfers","Others"];

    if (currentPage === 0) {
        tbody.innerHTML = '';

        // ✅ Opening Balance row — only on page 0, no active filters
        const noFilters = currentFilters.search === '' &&
            currentFilters.source === 'all' &&
            currentFilters.category === 'all' &&
            currentFilters.type === 'all' &&
            currentFilters.period === 'all' &&
            !currentFilters.flagged;

        if (noFilters) {
            const sortedStmts = [...statements].sort((a, b) =>
                parseDateStr(a.data?.[0]?.date) - parseDateStr(b.data?.[0]?.date)
            );
            const ob = parseFloat(sortedStmts[0]?.openingBalance) || 0;
            const obRow = document.createElement('tr');
            obRow.style.cssText = 'background:#f8fafc; font-style:italic;';
            obRow.innerHTML = `
                <td style="color:#94a3b8; font-size:12px;">—</td>
                <td style="color:#475569; font-size:13px; font-weight:600;">⚖️ Opening Balance (B/F)</td>
                <td></td>
                <td class="num-col" style="color:#94a3b8;">—</td>
                <td class="num-col" style="color:#94a3b8;">—</td>
                <td class="num-col" style="font-weight:700; color:#0f172a;">
                    ${ob.toLocaleString('en-IN', { minimumFractionDigits: 2 })}
                </td>
                <td></td>
                <td></td>
                <td></td>
                ${isEditorMode ? '<td></td>' : ''}
            `;
            tbody.appendChild(obRow);
        }
    }

    const frag = document.createDocumentFragment();
    slice.forEach(txn => {
        const d = parseFloat(txn.debit) || 0;
        const c = parseFloat(txn.credit) || 0;
        const b = parseFloat(txn.balance) || 0;
        const fmt = n => n.toLocaleString('en-IN', { minimumFractionDigits: 2 });

        const tr = document.createElement('tr');
        tr.setAttribute('data-id', txn.id);
        if (txn.isDuplicate) tr.classList.add('row-duplicate');

        const catOpts = ALL_CATS.map(opt =>
            `<option value="${opt}" ${txn.category === opt ? 'selected' : ''}>${opt}</option>`
        ).join('');

        tr.innerHTML = `
            <td>${isEditorMode
                ? `<input type="text" class="inline-input update-fld" data-id="${txn.id}" data-fld="date" value="${txn.date || ''}">`
                : (txn.date || '-')}
            </td>
            <td>${isEditorMode
                ? `<input type="text" class="inline-input update-fld" data-id="${txn.id}" data-fld="description" value="${(txn.description||'').replace(/"/g,'&quot;')}">`
                : (txn.description || '-')}
            </td>
            <td>${isEditorMode
                ? `<select class="inline-select update-fld cat-chip cat-${txn.category}" data-id="${txn.id}" data-fld="category">${catOpts}</select>`
                : `<span class="cat-chip cat-${txn.category}">${txn.category || 'Others'}</span>`}
            </td>
            <td class="num-col val-debit">${d > 0 ? fmt(d) : '-'}</td>
            <td class="num-col val-credit">${c > 0 ? fmt(c) : '-'}</td>
            <td class="num-col" style="font-weight:600;color:${b < 0 ? '#ef4444' : '#0f172a'}">${fmt(b)}</td>
            <td><span class="source-badge" title="${txn.sourceName}">${txn.sourceName}</span></td>
            <td>${isEditorMode
                ? `<input type="text" class="inline-input update-fld" data-id="${txn.id}" data-fld="notes" placeholder="Add note..." value="${(txn.notes||'').replace(/"/g,'&quot;')}">`
                : (txn.notes || '<span class="text-slate-300">—</span>')}
            </td>
            <td class="text-center">
                <span class="flag-btn ${txn.flagged ? 'active' : ''} update-flag" data-id="${txn.id}" title="Flag for review">🚩</span>
            </td>
            ${isEditorMode ? `<td class="text-center"><button class="delete-row" data-id="${txn.id}" title="Delete row">✕</button></td>` : ''}
        `;
        frag.appendChild(tr);
    });

    tbody.appendChild(frag);
    // ... rest of your load-more logic unchanged
    const loadMoreBtn = document.getElementById('load-more-btn');
    if (loadMoreBtn) {
        const hasMore = (start + PAGE_SIZE) < lastFilteredResults.length;
        loadMoreBtn.style.display = hasMore ? 'block' : 'none';
    }
}

function updateTableStatus() {
    const showing = Math.min((currentPage + 1) * PAGE_SIZE, lastFilteredResults.length);
    const dupes = masterTransactions.filter(t => t.isDuplicate).length;
    let txt = `Showing ${showing} of ${lastFilteredResults.length} transactions`;
    if (dupes > 0) txt += ` · ${dupes} duplicates hidden`;
    const el = document.getElementById('table-status');
    if (el) el.textContent = txt;
}

// ── 8. PATCH ROW ──
function patchRow(id, field, value) {
    const txn = masterTransactions.find(t => t.id === id);
    if (!txn) return;
    txn[field] = (field === 'category') ? normalizeCategory(value) : value;

    if (['description', 'notes', 'date'].includes(field)) {
        txn._searchIndex = [txn.date, txn.description, txn.debit, txn.credit, txn.notes]
            .join(' ').toLowerCase();
    }

    const stmt = statements.find(s => s.id === txn.sourceId);
    if (stmt) {
        const origIdx = parseInt(id.split('_').pop());
        if (stmt.data[origIdx]) stmt.data[origIdx][field] = txn[field];
    }
}

// ── 9. FILTER SETUP ──
function setupFilters() {
    const debouncedRender = debounce(renderTransactions, 200);

    document.getElementById('search-input').addEventListener('input', e => {
        currentFilters.search = e.target.value.toLowerCase().trim();
        debouncedRender();
    });

    ['filter-source', 'filter-category', 'filter-type', 'filter-period'].forEach(id => {
        const el = document.getElementById(id);
        if (!el) return;
        el.addEventListener('change', debounce(e => {
            const key = id.replace('filter-', '');
            currentFilters[key] = e.target.value;
            renderTransactions();
        }, 150));
    });

    const flagBtn = document.getElementById('filter-flagged');
    if (flagBtn) {
        flagBtn.addEventListener('click', () => {
            currentFilters.flagged = !currentFilters.flagged;
            flagBtn.classList.toggle('active');
            renderTransactions();
        });
    }

    document.getElementById('toggle-edit-btn')?.addEventListener('click', () => {
        isEditorMode = !isEditorMode;
        document.getElementById('ledger-tfoot')?.classList.toggle('hidden');
        document.getElementById('save-master-btn')?.classList.toggle('hidden');
        document.getElementById('toggle-edit-btn').textContent = isEditorMode ? "✓ Done Editing" : "✏️ Editor Mode";
        renderTransactions();
    });

    const loadMoreBtn = document.getElementById('load-more-btn');
    if (loadMoreBtn) {
        loadMoreBtn.addEventListener('click', () => {
            currentPage++;
            renderPage();
            updateTableStatus();
        });
    }

    const tbody = document.getElementById('ledger-tbody');

    tbody.addEventListener('click', e => {
        const id = e.target.getAttribute('data-id');

        if (e.target.classList.contains('update-flag')) {
            const txn = masterTransactions.find(t => t.id === id);
            if (!txn) return;
            patchRow(id, 'flagged', !txn.flagged);
            e.target.classList.toggle('active');
            debouncedFirebaseSave();
        }

        if (e.target.classList.contains('delete-row')) {
            deleteTransaction(id);
        }
    });

    tbody.addEventListener('change', e => {
        if (e.target.classList.contains('update-fld')) {
            const id = e.target.getAttribute('data-id');
            const fld = e.target.getAttribute('data-fld');
            patchRow(id, fld, e.target.value);
            if (fld === 'category') {
                const normalized = normalizeCategory(e.target.value);
                e.target.className = `inline-select update-fld cat-chip cat-${normalized}`;
            }
            debouncedFirebaseSave();
        }
    });
}

// ── 10. SOURCE & CATEGORY FILTER BUILDER ──
function updateSourceFilter() {
    const sel = document.getElementById('filter-source');
    if (!sel) return;
    sel.innerHTML = '<option value="all">All Sources</option>';
    statements.forEach(s => {
        const opt = document.createElement('option');
        opt.value = s.id;
        opt.textContent = s.name;
        sel.appendChild(opt);
    });

    const catSel = document.getElementById('filter-category');
    if (!catSel) return;

   const ALL_CATS = [
    "Salaries", "Rent", "Loans & EMI", "Investments", "Tax & Govt",
    "Bank Charges", "Utilities", "Food & Dining", "Ecom / Online",
    "Cash", "Travel & Transport", "Healthcare & Medical",
    "Professional Fees", "Insurance", "Education",
    "Income", "Transfers", "Others"
];

    const catCounts = {};
    masterTransactions.forEach(t => {
        if (t.isDuplicate || t.isHidden) return;
        const cat = t.category || 'Others';
        catCounts[cat] = (catCounts[cat] || 0) + 1;
    });

    catSel.innerHTML = '<option value="all">All Categories</option>';
    ALL_CATS.forEach(cat => {
        const count = catCounts[cat] || 0;
        const opt = document.createElement('option');
        opt.value = cat;
        if (count === 0) {
            opt.disabled = true;
            opt.style.color = '#cbd5e1';
            opt.textContent = `${cat} (0)`;
        } else {
            opt.textContent = `${cat} (${count})`;
        }
        catSel.appendChild(opt);
    });
}

function updatePeriodFilter() {
    const sel = document.getElementById('filter-period');
    const sumSel = document.getElementById('summary-period-select');
    const periods = new Set();
    masterTransactions.forEach(t => { if (t._period) periods.add(t._period); });

    let html = '<option value="all">All Time</option>';
    const sorted = [...periods].sort((a, b) => new Date(a) - new Date(b));
    sorted.forEach(p => html += `<option value="${p}">${p}</option>`);
    if (sel) sel.innerHTML = html;
    if (sumSel) sumSel.innerHTML = html;
}

// ── 11. TRANSACTION CRUD ──
function updateTransactionData(id, field, value) {
    patchRow(id, field, value);
}

function deleteTransaction(id) {
    if (!confirm("Delete this transaction?")) return;
    const txn = masterTransactions.find(t => t.id === id);
    if (!txn) return;
    const stmt = statements.find(s => s.id === txn.sourceId);
    if (!stmt) return;
    const origIdx = parseInt(id.split('_').pop());
    stmt.data.splice(origIdx, 1);
    showToast("Transaction deleted. Save to confirm.", "info");
    rebuildMasterLedger();
    document.getElementById('save-master-btn')?.classList.remove('hidden');
}

// ── 12. TABS ──
function setupTabs() {
    const tabs = document.querySelectorAll('.bsa-tab');
    tabs.forEach(tab => {
        tab.addEventListener('click', () => {
            tabs.forEach(t => t.classList.remove('active'));
            document.querySelectorAll('.tab-content').forEach(c => {
                c.classList.add('hidden');
                c.classList.remove('active');
            });
            tab.classList.add('active');
            const targetId = tab.getAttribute('data-target');
            const targetContent = document.getElementById(targetId);
            if (targetContent) {
                targetContent.classList.remove('hidden');
                targetContent.classList.add('active');
            }
            if (targetId === 'tab-summary') renderSummary();
            if (targetId === 'tab-analytics') renderAnalytics();
        });
    });
}

// ── 13. STATEMENT MANAGER ──
function renderStatementManager() {
    const container = document.getElementById('stmt-badges-container');
    if (!container) return;
    container.innerHTML = statements.map(s => `
        <div class="stmt-badge ${s.isLocked ? 'locked' : ''}">
            🏦 ${s.name}
            <span class="text-[10px] text-slate-400 font-normal">(${(s.data||[]).length} txns)</span>
            ${s.isLocked
                ? `<span title="Locked">🔒</span>`
                : `<button class="delete-stmt text-red-400 hover:text-red-600 ml-1 text-xs" data-id="${s.id}" title="Remove statement">✕</button>`}
        </div>
    `).join('');

    container.querySelectorAll('.delete-stmt').forEach(btn => {
        btn.addEventListener('click', async e => {
            if (!confirm("Remove this statement and all its transactions?")) return;
            const id = e.target.getAttribute('data-id');
            await deleteDoc(doc(db, "projects", currentProjectId, "bsa", currentBsaId, "statements", id));
            showToast("Statement removed.", "info");
            await loadBsaData();
        });
    });
}

// ── 14. SUMMARY TAB ──
document.getElementById('summary-period-select')?.addEventListener('change', renderSummary);

function renderSummary() {
    const period = document.getElementById('summary-period-select')?.value || 'all';

    // Opening / closing balance calculation
    const sortedStmts = [...statements].sort((a, b) =>
        parseDateStr(a.data?.[0]?.date) - parseDateStr(b.data?.[0]?.date)
    );
    const globalOB = parseFloat(sortedStmts[0]?.openingBalance) || 0;

    let periodOpening = globalOB;
    if (period !== 'all') {
        const firstIdx = masterTransactions.findIndex(t => !t.isDuplicate && !t.isHidden && t._period === period);
        if (firstIdx > 0) periodOpening = parseFloat(masterTransactions[firstIdx - 1].balance) || 0;
        else if (firstIdx === 0) periodOpening = globalOB;
    }

    let sumIn = 0, sumOut = 0;
    const catsOut = {}, catsIn = {};

    masterTransactions.forEach(t => {
        if (t.isDuplicate || t.isHidden) return;
        if (period !== 'all' && t._period !== period) return;

        const d = parseFloat(t.debit) || 0;
        const c = parseFloat(t.credit) || 0;
        const cat = t.category || 'Others';

        if (d > 0) { sumOut += d; catsOut[cat] = (catsOut[cat] || 0) + d; }
        if (c > 0) { sumIn += c; catsIn[cat] = (catsIn[cat] || 0) + c; }
    });

    const net = sumIn - sumOut;
    const fmt0 = n => '₹' + n.toLocaleString('en-IN', { maximumFractionDigits: 0 });

    const set = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };
    set('sum-kpi-in', fmt0(sumIn));
    set('sum-kpi-out', fmt0(sumOut));
    set('sum-kpi-net', (net >= 0 ? '+' : '') + fmt0(net));
    const netEl = document.getElementById('sum-kpi-net');
    if (netEl) netEl.className = 'text-2xl font-black ' + (net >= 0 ? 'text-green-600' : 'text-red-600');
    set('debit-total-header', fmt0(sumOut));
    set('credit-total-header', fmt0(sumIn));
    set('sum-open', fmt0(periodOpening));
    set('sum-close', fmt0(periodOpening + net));

    const dTable = document.getElementById('debit-summary-table');
    if (dTable) dTable.innerHTML = Object.entries(catsOut).sort((a,b) => b[1]-a[1])
        .map(([k,v]) => `<tr>
            <td class="py-2 text-slate-700 cursor-pointer hover:text-indigo-600 drill-down" data-cat="${k}">${k}</td>
            <td class="text-right font-semibold val-debit">₹${v.toLocaleString('en-IN',{maximumFractionDigits:0})}</td>
        </tr>`).join('');

    const cTable = document.getElementById('credit-summary-table');
    if (cTable) cTable.innerHTML = Object.entries(catsIn).sort((a,b) => b[1]-a[1])
        .map(([k,v]) => `<tr>
            <td class="py-2 text-slate-700 cursor-pointer hover:text-indigo-600 drill-down" data-cat="${k}">${k}</td>
            <td class="text-right font-semibold val-credit">₹${v.toLocaleString('en-IN',{maximumFractionDigits:0})}</td>
        </tr>`).join('');

    document.querySelectorAll('.drill-down').forEach(el => {
        el.addEventListener('click', () => {
            const cat = el.getAttribute('data-cat');
            currentFilters.category = cat;
            const catSel = document.getElementById('filter-category');
            if (catSel) catSel.value = cat;
            document.querySelector('.bsa-tab[data-target="tab-transactions"]')?.click();
        });
    });
}

// ── 15. ANALYTICS TAB ──
function renderAnalytics() {
    const monthly = {};
    const catBreakdown = {};
    const recurringTracker = {};

    masterTransactions.forEach(t => {
        if (t.isDuplicate || t.isHidden) return;
        const d = parseFloat(t.debit) || 0;
        const c = parseFloat(t.credit) || 0;
        if (t._date.getTime() === 0) return;

        if (!monthly[t._period]) monthly[t._period] = { in: 0, out: 0, bal: 0 };
        monthly[t._period].in += c;
        monthly[t._period].out += d;
        monthly[t._period].bal = t.balance;

        if (d > 0) catBreakdown[t.category] = (catBreakdown[t.category] || 0) + d;

        if (d > 0) {
            const key = `${t.category}_${d}`;
            if (!recurringTracker[key]) recurringTracker[key] = { count: 0, amount: d, cat: t.category, desc: t.description };
            recurringTracker[key].count++;
        }
    });

    const labels = Object.keys(monthly).sort((a, b) => new Date(a) - new Date(b));
    const dataIn  = labels.map(l => monthly[l].in);
    const dataOut = labels.map(l => monthly[l].out);
    const dataBal = labels.map(l => monthly[l].bal);

    const COLORS = ['#ef4444','#f97316','#f59e0b','#84cc16','#06b6d4','#6366f1',
        '#a855f7','#ec4899','#10b981','#3b82f6','#8b5cf6','#14b8a6','#f43f5e','#64748b'];

    function upsertChart(key, canvasId, config) {
        if (chartInstances[key]) {
            chartInstances[key].data = config.data;
            chartInstances[key].update('none');
        } else {
            const canvas = document.getElementById(canvasId);
            if (!canvas) return;
            chartInstances[key] = new Chart(canvas, config);
        }
    }

    upsertChart('bar', 'chart-monthly-bar', {
        type: 'bar',
        data: { labels, datasets: [
            { label: 'Inflow',  data: dataIn,  backgroundColor: '#10b981' },
            { label: 'Outflow', data: dataOut, backgroundColor: '#ef4444' }
        ]},
        options: { animation: false, responsive: true, plugins: { legend: { position: 'top' } } }
    });

    upsertChart('donut', 'chart-category-donut', {
        type: 'doughnut',
        data: {
            labels: Object.keys(catBreakdown),
            datasets: [{ data: Object.values(catBreakdown), backgroundColor: COLORS }]
        },
        options: { animation: false, plugins: { legend: { position: 'right' } } }
    });

    upsertChart('line', 'chart-running-balance', {
        type: 'line',
        data: { labels, datasets: [{
            label: 'Closing Balance',
            data: dataBal,
            borderColor: '#4f46e5',
            tension: 0.3,
            fill: true,
            backgroundColor: 'rgba(79, 70, 229, 0.08)'
        }]},
        options: { animation: false, responsive: true }
    });

    const top10 = masterTransactions
        .filter(t => !t.isDuplicate && !t.isHidden)
        .sort((a, b) => Math.max(b.debit||0, b.credit||0) - Math.max(a.debit||0, a.credit||0))
        .slice(0, 10);
    const top10El = document.getElementById('top-10-table');
    if (top10El) top10El.innerHTML = top10.map(t => {
        const amt = Math.max(t.debit||0, t.credit||0);
        const isD = (t.debit||0) > 0;
        return `<tr>
            <td class="p-2 text-xs">${t.date}</td>
            <td class="p-2 text-xs truncate max-w-[180px]" title="${t.description}">${t.description}</td>
            <td class="p-2 text-xs"><span class="cat-chip cat-${t.category}">${t.category}</span></td>
            <td class="p-2 text-right text-xs font-bold ${isD ? 'val-debit' : 'val-credit'}">₹${amt.toLocaleString('en-IN')}</td>
        </tr>`;
    }).join('');

    const recurring = Object.values(recurringTracker)
        .filter(r => r.count >= 2)
        .sort((a, b) => b.count - a.count)
        .slice(0, 10);
    const recEl = document.getElementById('recurring-table');
    if (recEl) recEl.innerHTML = recurring.map(r => `<tr>
        <td class="p-2"><span class="cat-chip cat-${r.cat}">${r.cat}</span></td>
        <td class="p-2 text-xs truncate max-w-[150px]">${r.desc}</td>
        <td class="p-2 text-center"><span class="text-xs font-bold bg-slate-100 px-2 py-1 rounded">${r.count}×</span></td>
        <td class="p-2 text-right text-xs font-bold val-debit">₹${r.amount.toLocaleString('en-IN')}</td>
    </tr>`).join('');
}

// ── 16. SAVE & EXPORT ──
document.getElementById('save-master-btn')?.addEventListener('click', async () => {
    showToast("Saving...", "info");
    try {
        for (let stmt of statements) {
            await updateDoc(doc(db, "projects", currentProjectId, "bsa", currentBsaId, "statements", stmt.id), {
                data: stmt.data, updatedAt: serverTimestamp()
            });
        }
        showToast("Ledger saved!", "success");
    } catch (e) {
        showToast("Error saving ledger.", "error");
        console.error(e);
    }
});

document.getElementById('export-excel-btn')?.addEventListener('click', () => {
    const rows = masterTransactions.filter(t => !t.isDuplicate && !t.isHidden).map(t => ({
        Date: t.date, Description: t.description, Category: t.category,
        'Debit (Dr)': t.debit || 0, 'Credit (Cr)': t.credit || 0,
        Balance: t.balance || 0, Source: t.sourceName, Notes: t.notes || ''
    }));
    const ws = XLSX.utils.json_to_sheet(rows);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Ledger");
    XLSX.writeFile(wb, "Consolidated_Ledger.xlsx");
    showToast("Excel exported!", "success");
});

document.getElementById('export-pdf-btn')?.addEventListener('click', () => {
    const el = document.getElementById('pdf-export-area');
    if (!el) return;
    html2pdf().from(el).set({ margin: 1, filename: 'Financial_Summary.pdf', html2canvas: { scale: 2 } }).save();
    showToast("PDF exported!", "success");
});

document.getElementById('export-csv-btn')?.addEventListener('click', () => {
    let csv = "Date,Description,Category,Debit,Credit,Balance,Source,Notes\n";
    masterTransactions.filter(t => !t.isDuplicate && !t.isHidden).forEach(t => {
        csv += `"${t.date}","${(t.description||'').replace(/"/g,'""')}","${t.category}",${t.debit||0},${t.credit||0},${t.balance||0},"${t.sourceName}","${(t.notes||'').replace(/"/g,'""')}"\n`;
    });
    const link = document.createElement("a");
    link.href = "data:text/csv;charset=utf-8," + encodeURIComponent(csv);
    link.download = "transactions.csv";
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    showToast("CSV exported!", "success");
});

// ── 17. TOAST ──
function showToast(msg, type = "info") {
    const toast = document.createElement('div');
    const colors = { success: '#16a34a', error: '#dc2626', info: '#1e293b' };
    toast.className = 'toast';
    toast.style.background = colors[type] || colors.info;
    toast.textContent = msg;
    document.getElementById('toast-container')?.appendChild(toast);
    setTimeout(() => toast.remove(), 3000);
}

// ── 18. DEDUPLICATION RESOLVER ──
const dedupeBtn  = document.getElementById('toggle-dedupe-btn');
const dedupeModal = document.getElementById('dedupe-modal');

dedupeBtn?.addEventListener('click', () => {
    renderDedupeModal();
    dedupeModal?.classList.remove('hidden');
});
document.getElementById('close-dedupe-btn')?.addEventListener('click', () => dedupeModal?.classList.add('hidden'));
document.getElementById('apply-dedupe-btn')?.addEventListener('click', () => {
    applyDeduplication();
    dedupeModal?.classList.add('hidden');
});

function renderDedupeModal() {
    const list = document.getElementById('dedupe-list');
    if (!list) return;
    const dupes = masterTransactions.filter(t => t.isDuplicate);

    if (dupes.length === 0) {
        list.innerHTML = '<p class="text-sm text-slate-500 text-center py-4">No duplicates found.</p>';
        return;
    }

    list.innerHTML = dupes.map(txn => {
        const amt = Math.max(txn.debit||0, txn.credit||0);
        const isD = (txn.debit||0) > 0;
        return `
        <div class="flex items-center justify-between p-3 border border-slate-200 rounded-lg mb-2 bg-slate-50">
            <div class="flex-1 overflow-hidden pr-4">
                <div class="text-xs font-bold text-slate-500 mb-1">${txn.date} · <span class="text-indigo-600">${txn.sourceName}</span></div>
                <div class="text-sm text-slate-800 truncate" title="${txn.description}">${txn.description}</div>
            </div>
            <div class="text-right flex flex-col items-end gap-2">
                <div class="text-sm font-bold ${isD ? 'val-debit' : 'val-credit'}">₹${amt.toLocaleString('en-IN',{minimumFractionDigits:2})}</div>
                <label class="flex items-center gap-2 cursor-pointer bg-white px-2 py-1 border border-slate-200 rounded text-xs font-semibold hover:bg-slate-100">
                    <input type="checkbox" class="dedupe-checkbox accent-indigo-600 w-4 h-4" value="${txn.id}" checked>
                    Delete this copy
                </label>
            </div>
        </div>`;
    }).join('');
}

function applyDeduplication() {
    const checked = document.querySelectorAll('.dedupe-checkbox:checked');
    const toDelete = new Set(Array.from(checked).map(cb => cb.value));
    if (toDelete.size === 0) return;

    statements.forEach(stmt => {
        stmt.data = stmt.data.filter((_, idx) => !toDelete.has(`${stmt.id}_${idx}`));
    });

    showToast(`Removed ${toDelete.size} duplicate(s). Save to confirm.`, "success");
    rebuildMasterLedger();
    document.getElementById('save-master-btn')?.classList.remove('hidden');
}