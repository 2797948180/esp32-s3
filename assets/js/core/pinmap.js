/* ESP32-S3 引脚安全映射表
 *
 * 依据 Espressif 官方《ESP32-S3 技术参考手册 / 硬件设计指南》整理的**通用分类**。
 * 各开发板实际引出情况不同，这里只做"能否安全开放给用户"的初筛：
 *   safe   —— 通用情况下可直接用于数字输入/输出/PWM
 *   warn   —— 有启动/外设占用风险，需用户显式勾选"显示风险引脚"才会出现
 *   unsafe —— 绝对不开放（Flash/PSRAM/USB/UART0Console/启动绑带）
 *
 * 用户必须在系统设置里选择与实物一致的开发板型号，并在 docs/HARDWARE.md 中核对。
 * 绝对不要假设通用分类与你的板子完全一致。 */
(function (global) {
  'use strict';
  var ESP = global.ESP = global.ESP || {};

  var CHIP = {
    id: 'esp32-s3',
    name: 'ESP32-S3',
    cores: 2,
    // ESP32-S3 实际存在的 GPIO：0-21 与 26-48（22-25 未引出）
    existing: (function () {
      var a = [];
      for (var i = 0; i <= 21; i++) a.push(i);
      for (var j = 26; j <= 48; j++) a.push(j);
      return a;
    })(),
    // ESP32-S3 LEDC
    pwmChannels: 8,
    adc1: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
    adc2: [11, 12, 13, 14, 15, 16, 17, 18, 19, 20],
    touch: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14]
  };

  /* 芯片级不可开放引脚（任何 ESP32-S3 都成立） */
  var CHIP_RESERVED = {
    19: 'USB Serial/JTAG D-（原生 USB，占用会导致无法烧录/调试）',
    20: 'USB Serial/JTAG D+（原生 USB，占用会导致无法烧录/调试）'
  };

  /* Flash / PSRAM 占用（所有带内置 Flash 的模组，如 ESP32-S3-WROOM-1） */
  var FLASH_RESERVED = {
    26: '内置 Flash/PSRAM SPICS1',
    27: '内置 Flash/PSRAM SPIHD',
    28: '内置 Flash/PSRAM SPIWP',
    29: '内置 Flash/PSRAM SPICS0',
    30: '内置 Flash/PSRAM SPICLK',
    31: '内置 Flash/PSRAM SPIQ (MISO)',
    32: '内置 Flash/PSRAM SPID (MOSI)'
  };

  /* Octal PSRAM / Octal Flash 占用（N8R8 / N16R8 等带 8 线 PSRAM 的模组） */
  var OCTAL_RESERVED = {
    33: 'Octal PSRAM/Flash D4（8 线 PSRAM 模组占用）',
    34: 'Octal PSRAM/Flash D5（8 线 PSRAM 模组占用）',
    35: 'Octal PSRAM/Flash D6（8 线 PSRAM 模组占用）',
    36: 'Octal PSRAM/Flash D7（8 线 PSRAM 模组占用）',
    37: 'Octal PSRAM/Flash DM/SPICS1（8 线 PSRAM 模组占用）'
  };

  /* 启动绑带（Strapping）—— 接错会导致无法启动 */
  var STRAPPING = {
    0: '启动绑带 GPIO0：影响芯片启动模式，亦是多数开发板的 BOOT 按键',
    3: '启动绑带 GPIO3：影响 JTAG 信号源选择（eFuse）',
    45: '启动绑带 GPIO45：选择 VDD_SPI 电压，拉错会导致 Flash 无法启动',
    46: '启动绑带 GPIO46：选择 VDD_SPI 电压，拉错会导致 Flash 无法启动'
  };

  /* UART0 默认串口（多数开发板接 USB 桥接芯片并用于日志输出） */
  var UART0 = { 43: 'UART0 TXD（默认串口输出）', 44: 'UART0 RXD（默认串口输入）' };

  function merge() {
    var out = {};
    for (var i = 0; i < arguments.length; i++) {
      var src = arguments[i];
      if (src) for (var k in src) out[k] = src[k];
    }
    return out;
  }

  /* --------------------------- 开发板配置 --------------------------- */
  var BOARDS = [
    {
      id: 'esp32-s3-devkitc-1-n16r8',
      name: 'ESP32-S3-DevKitC-1 (N16R8 · 16MB Flash + 8MB Octal PSRAM)',
      note: '目前最常见的 DevKitC-1 配置。板载 RGB LED 占用 GPIO48，BOOT 键占用 GPIO0，串口日志占用 GPIO43/44。',
      reserved: merge(CHIP_RESERVED, FLASH_RESERVED, OCTAL_RESERVED, UART0, { 48: '开发板板载 RGB LED（WS2812）' }),
      warn: merge(STRAPPING)
    },
    {
      id: 'esp32-s3-devkitc-1-n8',
      name: 'ESP32-S3-DevKitC-1 (无 PSRAM 或 Quad PSRAM)',
      note: 'GPIO33-37 未被 Octal PSRAM 占用，可作为普通 GPIO（列入"风险引脚"）。请在接线前确认模组型号。',
      reserved: merge(CHIP_RESERVED, FLASH_RESERVED, UART0, { 48: '开发板板载 RGB LED（WS2812）' }),
      warn: merge(STRAPPING, OCTAL_RESERVED)
    },
    {
      id: 'esp32-s3-wroom-1',
      name: 'ESP32-S3-WROOM-1 / WROOM-2 裸模组自有电路板',
      note: '无板载 LED / BOOT 键假设；仍保留 Flash、USB、UART0 与启动绑带。',
      reserved: merge(CHIP_RESERVED, FLASH_RESERVED, OCTAL_RESERVED, UART0),
      warn: merge(STRAPPING)
    },
    {
      id: 'esp32-s3-devkitm-1',
      name: 'ESP32-S3-DevKitM-1 (Mini)',
      note: '小板型，实际引出引脚较少，请再核对你的排针。',
      reserved: merge(CHIP_RESERVED, FLASH_RESERVED, OCTAL_RESERVED, UART0),
      warn: merge(STRAPPING),
      // DevKitM-1 并未引出全部引脚
      only: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 21, 33, 34, 35, 36, 37, 38, 39, 40, 41, 42, 43, 44, 45, 46, 47, 48]
    },
    {
      id: 'legacy-4pin',
      name: '沿用旧固件白名单（仅 GPIO4/5/6/7/8）',
      note: '与本项目原始固件 ESP32S3WiFiControl.ino 完全一致：输入 4、数字输出 5/6、PWM 7/8。用于对照测试或兼容旧固件。',
      reserved: merge(CHIP_RESERVED, FLASH_RESERVED, OCTAL_RESERVED, UART0, STRAPPING),
      warn: {},
      only: [4, 5, 6, 7, 8]
    },
    {
      id: 'custom',
      name: '自定义（手工勾选可用引脚）',
      note: '仅过滤芯片级必须保留的引脚。你需要自行确认板子的实际引出与外设占用。',
      reserved: merge(CHIP_RESERVED, FLASH_RESERVED),
      warn: merge(STRAPPING, OCTAL_RESERVED, UART0),
      custom: true
    }
  ];

  function boardById(id) {
    for (var i = 0; i < BOARDS.length; i++) if (BOARDS[i].id === id) return BOARDS[i];
    return BOARDS[0];
  }

  /* ADC 通道名 */
  function adcOf(gpio) {
    var i1 = CHIP.adc1.indexOf(gpio);
    if (i1 >= 0) return { unit: 1, ch: i1, name: 'ADC1_CH' + i1, usableWithWifi: true };
    var i2 = CHIP.adc2.indexOf(gpio);
    if (i2 >= 0) return { unit: 2, ch: i2, name: 'ADC2_CH' + i2, usableWithWifi: false };
    return null;
  }

  /* 生成某开发板的完整引脚表 */
  function buildTable(boardId) {
    var board = boardById(boardId);
    var list = CHIP.existing.slice();
    if (board.only) list = board.only.slice().sort(function (a, b) { return a - b; });

    return list.map(function (gpio) {
      var level, reason = '';
      if (board.reserved[gpio] != null) { level = 'unsafe'; reason = board.reserved[gpio]; }
      else if (board.warn[gpio] != null) { level = 'warn'; reason = board.warn[gpio]; }
      else { level = 'safe'; reason = ''; }

      var adc = adcOf(gpio);
      var caps = ['digital_in', 'digital_out', 'pwm'];
      if (adc) caps.push('adc');
      if (CHIP.touch.indexOf(gpio) >= 0) caps.push('touch');

      return {
        gpio: gpio,
        level: level,
        reason: reason,
        adc: adc ? adc.name : null,
        adcNote: adc && !adc.usableWithWifi ? 'Wi-Fi 开启时 ADC2 不可用' : '',
        caps: caps
      };
    });
  }

  /* 可以被用户使用的引脚（level !== 'unsafe'） */
  function usablePins(boardId, includeRisk) {
    return buildTable(boardId).filter(function (p) {
      return p.level === 'safe' || (includeRisk && p.level === 'warn');
    });
  }

  function meta(boardId) {
    return {
      chip: CHIP,
      board: boardById(boardId),
      pwm: {
        channels: CHIP.pwmChannels,
        resolutions: [1, 8, 10, 12, 14],
        defaultResolution: 10,
        minFreq: 10,
        maxFreq: 80000000,
        defaultFreq: 1000
      }
    };
  }

  ESP.pins = {
    CHIP: CHIP,
    BOARDS: BOARDS,
    boardById: boardById,
    buildTable: buildTable,
    usablePins: usablePins,
    meta: meta
  };
})(window);
