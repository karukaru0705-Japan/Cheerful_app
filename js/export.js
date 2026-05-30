// ===== Excel書き出し（収入/支出/合計の3タブ、チアフル会計フォーマット準拠） =====
const ExcelExport = (() => {

  // agg: { year, carryover, incomeRows:[{cat,amount,detail}], expenseRows:[...], incomeTotal, expenseTotal, balance }
  function build(agg) {
    const wb = XLSX.utils.book_new();

    // --- 収入シート ---
    const incomeAOA = [['収入', '摘要', '金額', '内訳']];
    agg.incomeRows.forEach((r) => incomeAOA.push([null, r.cat, r.amount, r.detail || null]));
    incomeAOA.push([null, '収入合計', agg.incomeTotal, null]);
    const wsIncome = XLSX.utils.aoa_to_sheet(incomeAOA);
    wsIncome['!cols'] = [{ wch: 6 }, { wch: 18 }, { wch: 12 }, { wch: 40 }];
    XLSX.utils.book_append_sheet(wb, wsIncome, '収入');

    // --- 支出シート ---
    const expenseAOA = [['支出', '摘要', '金額', '内訳']];
    agg.expenseRows.forEach((r) => expenseAOA.push([null, r.cat, r.amount, r.detail || null]));
    expenseAOA.push([null, '支出合計', agg.expenseTotal, null]);
    const wsExpense = XLSX.utils.aoa_to_sheet(expenseAOA);
    wsExpense['!cols'] = [{ wch: 6 }, { wch: 18 }, { wch: 12 }, { wch: 40 }];
    XLSX.utils.book_append_sheet(wb, wsExpense, '支出');

    // --- 合計シート（収入＋支出を縦に並べ、差引残高） ---
    const totalAOA = [];
    totalAOA.push([`チアフル会計　${agg.year || ''}　${agg.periodText || ''}`, null, null, null]);
    totalAOA.push(['収入', '摘要', '金額', '内訳']);
    agg.incomeRows.forEach((r) => totalAOA.push([null, r.cat, r.amount, r.detail || null]));
    totalAOA.push([null, '収入合計', agg.incomeTotal, null]);
    totalAOA.push([null, null, null, null]);
    totalAOA.push(['支出', '摘要', '金額', '内訳']);
    agg.expenseRows.forEach((r) => totalAOA.push([null, r.cat, r.amount, r.detail || null]));
    totalAOA.push([null, '支出合計', agg.expenseTotal, null]);
    totalAOA.push([null, null, null, null]);
    totalAOA.push([null, '差引残高', agg.balance, null]);
    const wsTotal = XLSX.utils.aoa_to_sheet(totalAOA);
    wsTotal['!cols'] = [{ wch: 6 }, { wch: 18 }, { wch: 12 }, { wch: 40 }];
    XLSX.utils.book_append_sheet(wb, wsTotal, '合計');

    // --- 全取引シート（古い順、残高付き）---
    if (agg.allItems && Array.isArray(agg.allItems)) {
      const allAOA = [['日付', '種別', 'カテゴリ', '内容', '金額', '残高']];
      agg.allItems.forEach((it) => {
        allAOA.push([it.date || '', it.type || '', it.category || '', it.desc || '', it.amount || 0, it.runningBalance != null ? it.runningBalance : '']);
      });
      const wsAll = XLSX.utils.aoa_to_sheet(allAOA);
      wsAll['!cols'] = [{ wch: 12 }, { wch: 6 }, { wch: 14 }, { wch: 32 }, { wch: 12 }, { wch: 12 }];
      XLSX.utils.book_append_sheet(wb, wsAll, '全取引');
    }

    return wb;
  }

  function download(agg) {
    const wb = build(agg);
    const safeYear = (agg.year || '会計').replace(/[\/\\:*?"<>|]/g, '_');
    XLSX.writeFile(wb, `チアフル会計_${safeYear}.xlsx`, { compression: true });
  }

  return { build, download };
})();
