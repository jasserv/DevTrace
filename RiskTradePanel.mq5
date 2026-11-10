//+------------------------------------------------------------------+
//| RiskTradePanel.mq5 - MT5 risk-based one-click trade panel        |
//| v2.00 - Draggable chart lines, panel move/resize, toggles        |
//+------------------------------------------------------------------+
#property strict
#property version "2.00"
#include <Trade/Trade.mqh>
CTrade trade;

//--- Inputs
input int    PanelX            = 18;
input int    PanelY            = 35;
input ulong  MagicNumber       = 6111026;
input int    SlippagePoints    = 20;
input bool   ConfirmBeforeTrade= true;
input double DefaultCapital    = 5000.0;
input double DefaultDollarRisk = 25.0;
input double DefaultRiskPercent= 0.50;
input bool   StartInFixedDollar= true;
input int    DefaultPanelScale = 100;  // Panel scale 80-150 %

//--- Prefixes
string P  = "RTP_";       // Panel objects
string LP = "RTP_LINE_";  // Chart-line objects

//--- Layout base
int    BASEW = 360;

//--- State
bool   settings  = false, busy = false;
string mode      = "FIXED";
double capital   = 5000, dollarRisk = 25, riskPercent = 0.5;
bool   showLong  = true, showShort = true;
int    curPanelX, curPanelY;
int    panelScale = 100;

//--- Panel drag state
bool   panelDragging    = false;
bool   panelDragPending = false;
int    pendingDragX, pendingDragY;
int    dragOffsetX, dragOffsetY;

struct Setup { double entry, sl, tp; };
Setup lng, sht;

//+------------------------------------------------------------------+
//|                    HELPER FUNCTIONS                                |
//+------------------------------------------------------------------+
string Id(string s) { return P + s; }

// Scale a pixel value by the current panel scale
int S(int v) { return (int)MathRound(v * panelScale / 100.0); }

// Scale a font size (minimum 7)
int FS(int base) { int r = (int)MathRound(base * panelScale / 100.0); return (r < 7) ? 7 : r; }

void Label(string n, string t, int x, int y, color c = clrWhite, int fs = 9)
{
   string a = Id(n);
   if(ObjectFind(0, a) < 0)
      ObjectCreate(0, a, OBJ_LABEL, 0, 0, 0);
   ObjectSetInteger(0, a, OBJPROP_CORNER, CORNER_LEFT_UPPER);
   ObjectSetInteger(0, a, OBJPROP_XDISTANCE, curPanelX + S(x));
   ObjectSetInteger(0, a, OBJPROP_YDISTANCE, curPanelY + S(y));
   ObjectSetInteger(0, a, OBJPROP_COLOR, c);
   ObjectSetInteger(0, a, OBJPROP_FONTSIZE, FS(fs));
   ObjectSetString (0, a, OBJPROP_FONT, "Arial");
   ObjectSetString (0, a, OBJPROP_TEXT, t);
   ObjectSetInteger(0, a, OBJPROP_SELECTABLE, false);
   ObjectSetInteger(0, a, OBJPROP_HIDDEN, true);
}

void Edit(string n, string v, int x, int y, int w = 105, int h = 20, int fs = 9)
{
   string a = Id(n);
   if(ObjectFind(0, a) < 0)
      ObjectCreate(0, a, OBJ_EDIT, 0, 0, 0);
   ObjectSetInteger(0, a, OBJPROP_CORNER, CORNER_LEFT_UPPER);
   ObjectSetInteger(0, a, OBJPROP_XDISTANCE, curPanelX + S(x));
   ObjectSetInteger(0, a, OBJPROP_YDISTANCE, curPanelY + S(y));
   ObjectSetInteger(0, a, OBJPROP_XSIZE, S(w));
   ObjectSetInteger(0, a, OBJPROP_YSIZE, S(h));
   ObjectSetInteger(0, a, OBJPROP_COLOR, clrWhite);
   ObjectSetInteger(0, a, OBJPROP_BGCOLOR, C'35,39,47');
   ObjectSetInteger(0, a, OBJPROP_BORDER_COLOR, C'85,90,100');
   ObjectSetInteger(0, a, OBJPROP_FONTSIZE, FS(fs));
   ObjectSetInteger(0, a, OBJPROP_ALIGN, ALIGN_RIGHT);
   ObjectSetString (0, a, OBJPROP_TEXT, v);
   ObjectSetInteger(0, a, OBJPROP_HIDDEN, true);
}

void Button(string n, string t, int x, int y, int w, int h, color bg, int fs = 9)
{
   string a = Id(n);
   if(ObjectFind(0, a) < 0)
      ObjectCreate(0, a, OBJ_BUTTON, 0, 0, 0);
   ObjectSetInteger(0, a, OBJPROP_CORNER, CORNER_LEFT_UPPER);
   ObjectSetInteger(0, a, OBJPROP_XDISTANCE, curPanelX + S(x));
   ObjectSetInteger(0, a, OBJPROP_YDISTANCE, curPanelY + S(y));
   ObjectSetInteger(0, a, OBJPROP_XSIZE, S(w));
   ObjectSetInteger(0, a, OBJPROP_YSIZE, S(h));
   ObjectSetInteger(0, a, OBJPROP_BGCOLOR, bg);
   ObjectSetInteger(0, a, OBJPROP_COLOR, clrWhite);
   ObjectSetInteger(0, a, OBJPROP_BORDER_COLOR, bg);
   ObjectSetInteger(0, a, OBJPROP_FONTSIZE, FS(fs));
   ObjectSetString (0, a, OBJPROP_TEXT, t);
   ObjectSetInteger(0, a, OBJPROP_HIDDEN, true);
   ObjectSetInteger(0, a, OBJPROP_STATE, false);
}

void Status(string s)
{
   if(ObjectFind(0, Id("STATUS")) >= 0)
      ObjectSetString(0, Id("STATUS"), OBJPROP_TEXT, s);
   ChartRedraw();
}

//+------------------------------------------------------------------+
//|                   CHART LINE HELPERS                               |
//+------------------------------------------------------------------+
void HLine(string suffix, double price, color clr, ENUM_LINE_STYLE style, int width, string tip)
{
   if(price <= 0) return;
   string name = LP + suffix;
   if(ObjectFind(0, name) < 0)
      ObjectCreate(0, name, OBJ_HLINE, 0, 0, price);
   ObjectSetDouble (0, name, OBJPROP_PRICE, 0, price);
   ObjectSetInteger(0, name, OBJPROP_COLOR, clr);
   ObjectSetInteger(0, name, OBJPROP_STYLE, style);
   ObjectSetInteger(0, name, OBJPROP_WIDTH, width);
   ObjectSetInteger(0, name, OBJPROP_SELECTABLE, true);
   ObjectSetInteger(0, name, OBJPROP_SELECTED, false);
   ObjectSetInteger(0, name, OBJPROP_BACK, false);
   ObjectSetInteger(0, name, OBJPROP_HIDDEN, false);
   ObjectSetString (0, name, OBJPROP_TEXT, tip);
   ObjectSetString (0, name, OBJPROP_TOOLTIP, tip + ": " + DoubleToString(price, _Digits));
}

// Draw a filled price-zone rectangle spanning the full chart width
void FillRect(string suffix, double price1, double price2, color clr)
{
   if(price1 <= 0 || price2 <= 0) return;
   string name = LP + suffix;
   datetime t1 = D'2000.01.01';
   datetime t2 = D'2099.12.31';
   if(ObjectFind(0, name) < 0)
      ObjectCreate(0, name, OBJ_RECTANGLE, 0, t1, price1, t2, price2);
   ObjectSetDouble (0, name, OBJPROP_PRICE, 0, price1);
   ObjectSetDouble (0, name, OBJPROP_PRICE, 1, price2);
   ObjectSetInteger(0, name, OBJPROP_TIME,  0, t1);
   ObjectSetInteger(0, name, OBJPROP_TIME,  1, t2);
   ObjectSetInteger(0, name, OBJPROP_COLOR, clr);
   ObjectSetInteger(0, name, OBJPROP_FILL,  true);
   ObjectSetInteger(0, name, OBJPROP_BACK,  true);
   ObjectSetInteger(0, name, OBJPROP_SELECTABLE, false);
   ObjectSetInteger(0, name, OBJPROP_HIDDEN, true);
}

// Create / refresh all six chart lines + fill zones (respects showLong/showShort)
void UpdateLines()
{
   if(showLong)
   {
      HLine("L_ENTRY", lng.entry, C'75,210,130',  STYLE_SOLID,   2, "Long Entry");
      HLine("L_SL",    lng.sl,    C'245,105,105',  STYLE_DASH,    1, "Long SL");
      HLine("L_TP",    lng.tp,    C'100,180,255',  STYLE_DASHDOT, 1, "Long TP");
      FillRect("L_SL_ZONE", lng.entry, lng.sl, C'65,22,22');   // red SL zone
      FillRect("L_TP_ZONE", lng.entry, lng.tp, C'18,55,32');   // green TP zone
   }
   else
   {
      ObjectDelete(0, LP + "L_ENTRY");
      ObjectDelete(0, LP + "L_SL");
      ObjectDelete(0, LP + "L_TP");
      ObjectDelete(0, LP + "L_SL_ZONE");
      ObjectDelete(0, LP + "L_TP_ZONE");
   }

   if(showShort)
   {
      HLine("S_ENTRY", sht.entry, C'255,150,80',   STYLE_SOLID,      2, "Short Entry");
      HLine("S_SL",    sht.sl,    C'245,80,80',     STYLE_DOT,        1, "Short SL");
      HLine("S_TP",    sht.tp,    C'80,200,255',    STYLE_DASHDOTDOT, 1, "Short TP");
      FillRect("S_SL_ZONE", sht.entry, sht.sl, C'65,22,22');   // red SL zone
      FillRect("S_TP_ZONE", sht.entry, sht.tp, C'18,55,32');   // green TP zone
   }
   else
   {
      ObjectDelete(0, LP + "S_ENTRY");
      ObjectDelete(0, LP + "S_SL");
      ObjectDelete(0, LP + "S_TP");
      ObjectDelete(0, LP + "S_SL_ZONE");
      ObjectDelete(0, LP + "S_TP_ZONE");
   }
}

// After user drags a chart line, sync its price back to the edit field + struct
void SyncFromLine(string objName)
{
   double price = ObjectGetDouble(0, objName, OBJPROP_PRICE, 0);
   price = NormalizeDouble(price, _Digits);
   string suffix = StringSubstr(objName, StringLen(LP));

   if(suffix == "L_ENTRY") { lng.entry = price; if(ObjectFind(0, Id("L_ENTRY")) >= 0) ObjectSetString(0, Id("L_ENTRY"), OBJPROP_TEXT, DoubleToString(price, _Digits)); }
   if(suffix == "L_SL")    { lng.sl    = price; if(ObjectFind(0, Id("L_SL"))    >= 0) ObjectSetString(0, Id("L_SL"),    OBJPROP_TEXT, DoubleToString(price, _Digits)); }
   if(suffix == "L_TP")    { lng.tp    = price; if(ObjectFind(0, Id("L_TP"))    >= 0) ObjectSetString(0, Id("L_TP"),    OBJPROP_TEXT, DoubleToString(price, _Digits)); }
   if(suffix == "S_ENTRY") { sht.entry = price; if(ObjectFind(0, Id("S_ENTRY")) >= 0) ObjectSetString(0, Id("S_ENTRY"), OBJPROP_TEXT, DoubleToString(price, _Digits)); }
   if(suffix == "S_SL")    { sht.sl    = price; if(ObjectFind(0, Id("S_SL"))    >= 0) ObjectSetString(0, Id("S_SL"),    OBJPROP_TEXT, DoubleToString(price, _Digits)); }
   if(suffix == "S_TP")    { sht.tp    = price; if(ObjectFind(0, Id("S_TP"))    >= 0) ObjectSetString(0, Id("S_TP"),    OBJPROP_TEXT, DoubleToString(price, _Digits)); }

   // Update the tooltip with the new price
   ObjectSetString(0, objName, OBJPROP_TOOLTIP,
                   ObjectGetString(0, objName, OBJPROP_TEXT) + ": " + DoubleToString(price, _Digits));
}

//+------------------------------------------------------------------+
//|                 PANEL MANAGEMENT                                   |
//+------------------------------------------------------------------+
// Remove only panel UI objects (labels, edits, buttons, backgrounds) — not chart lines
void RemovePanel()
{
   for(int i = ObjectsTotal(0) - 1; i >= 0; i--)
   {
      string n = ObjectName(0, i);
      if(StringFind(n, P) == 0 && StringFind(n, LP) != 0)
         ObjectDelete(0, n);
   }
}

// Remove only chart lines
void RemoveLines()
{
   for(int i = ObjectsTotal(0) - 1; i >= 0; i--)
   {
      string n = ObjectName(0, i);
      if(StringFind(n, LP) == 0)
         ObjectDelete(0, n);
   }
}

// Remove everything (panel + lines)
void RemoveAll()
{
   for(int i = ObjectsTotal(0) - 1; i >= 0; i--)
   {
      string n = ObjectName(0, i);
      if(StringFind(n, P) == 0)
         ObjectDelete(0, n);
   }
}

// Translate every panel object (not chart lines) by a pixel delta
void MovePanel(int newX, int newY)
{
   int dx = newX - curPanelX;
   int dy = newY - curPanelY;
   curPanelX = newX;
   curPanelY = newY;
   for(int i = ObjectsTotal(0) - 1; i >= 0; i--)
   {
      string name = ObjectName(0, i);
      if(StringFind(name, P) == 0 && StringFind(name, LP) != 0)
      {
         ENUM_OBJECT type = (ENUM_OBJECT)ObjectGetInteger(0, name, OBJPROP_TYPE);
         if(type == OBJ_LABEL || type == OBJ_EDIT || type == OBJ_BUTTON || type == OBJ_RECTANGLE_LABEL)
         {
            int oldX = (int)ObjectGetInteger(0, name, OBJPROP_XDISTANCE);
            int oldY = (int)ObjectGetInteger(0, name, OBJPROP_YDISTANCE);
            ObjectSetInteger(0, name, OBJPROP_XDISTANCE, oldX + dx);
            ObjectSetInteger(0, name, OBJPROP_YDISTANCE, oldY + dy);
         }
      }
   }
   ChartRedraw();
}

//+------------------------------------------------------------------+
//|                DATA / CALCULATION HELPERS                          |
//+------------------------------------------------------------------+
double Read(string n, double fallback)
{
   string s = ObjectGetString(0, Id(n), OBJPROP_TEXT);
   StringReplace(s, ",", ".");
   if(s == "") return fallback;
   return StringToDouble(s);
}

int VolDigits()
{
   double s = SymbolInfoDouble(_Symbol, SYMBOL_VOLUME_STEP);
   if(s >= 1)     return 0;
   if(s >= 0.1)   return 1;
   if(s >= 0.01)  return 2;
   if(s >= 0.001) return 3;
   return 4;
}

double RiskAmount() { return mode == "FIXED" ? dollarRisk : capital * riskPercent / 100.0; }

double LotsNormalize(double v)
{
   double step = SymbolInfoDouble(_Symbol, SYMBOL_VOLUME_STEP);
   double minv = SymbolInfoDouble(_Symbol, SYMBOL_VOLUME_MIN);
   double maxv = SymbolInfoDouble(_Symbol, SYMBOL_VOLUME_MAX);
   if(step <= 0)  return 0;
   v = MathFloor(v / step + 1e-9) * step;
   v = MathMin(v, maxv);
   v = NormalizeDouble(v, VolDigits());
   if(v < minv) return 0;
   return v;
}

bool ReadSetup(bool isLong, Setup &s)
{
   if(isLong)
   { s.entry = Read("L_ENTRY", 0); s.sl = Read("L_SL", 0); s.tp = Read("L_TP", 0); }
   else
   { s.entry = Read("S_ENTRY", 0); s.sl = Read("S_SL", 0); s.tp = Read("S_TP", 0); }
   if(s.entry <= 0 || s.sl <= 0 || s.tp <= 0) return false;
   if(isLong  && !(s.sl < s.entry && s.tp > s.entry)) return false;
   if(!isLong && !(s.tp < s.entry && s.entry < s.sl)) return false;
   return true;
}

double CalcLots(bool isLong, Setup &s, double &risk, double &reward)
{
   risk = 0; reward = 0;
   double amount = RiskAmount(), loss = 0, gain = 0;
   ENUM_ORDER_TYPE ot = isLong ? ORDER_TYPE_BUY : ORDER_TYPE_SELL;
   if(amount <= 0 || capital <= 0) return 0;
   if(!OrderCalcProfit(ot, _Symbol, 1.0, s.entry, s.sl, loss)) return 0;
   if(!OrderCalcProfit(ot, _Symbol, 1.0, s.entry, s.tp, gain)) return 0;
   double perLot = MathAbs(loss);
   if(perLot <= 0) return 0;
   double vol = LotsNormalize(amount / perLot);
   if(vol <= 0) return 0;
   risk = perLot * vol;
   reward = MathAbs(gain) * vol;
   return vol;
}

void SaveSetups()
{
   lng.entry = Read("L_ENTRY", lng.entry); lng.sl = Read("L_SL", lng.sl); lng.tp = Read("L_TP", lng.tp);
   sht.entry = Read("S_ENTRY", sht.entry); sht.sl = Read("S_SL", sht.sl); sht.tp = Read("S_TP", sht.tp);
}

//+------------------------------------------------------------------+
//|                  DRAW THE PANEL                                    |
//+------------------------------------------------------------------+
void Draw()
{
   //--- Compute bottom-section Y offset (collapses when both sides hidden)
   int bY = (showLong || showShort) ? 236 : 55;

   //--- Panel height
   int panelH = settings ? (bY + 155) : (bY + 78);

   //--- Background
   string bg = Id("BG");
   ObjectCreate(0, bg, OBJ_RECTANGLE_LABEL, 0, 0, 0);
   ObjectSetInteger(0, bg, OBJPROP_CORNER, CORNER_LEFT_UPPER);
   ObjectSetInteger(0, bg, OBJPROP_XDISTANCE, curPanelX);
   ObjectSetInteger(0, bg, OBJPROP_YDISTANCE, curPanelY);
   ObjectSetInteger(0, bg, OBJPROP_XSIZE, S(BASEW));
   ObjectSetInteger(0, bg, OBJPROP_YSIZE, S(panelH));
   ObjectSetInteger(0, bg, OBJPROP_BGCOLOR, C'23,27,34');
   ObjectSetInteger(0, bg, OBJPROP_COLOR, C'65,72,82');
   ObjectSetInteger(0, bg, OBJPROP_BACK, false);
   ObjectSetInteger(0, bg, OBJPROP_SELECTABLE, false);
   ObjectSetInteger(0, bg, OBJPROP_HIDDEN, true);

   //--- Title row (y=5..28)
   Label("TITLE", "RISK TRADE PANEL | " + _Symbol, 12, 8, clrWhite, 10);
   Button("SETTINGS", settings ? "Hide" : "Settings", 302, 5, 48, 22, C'65,72,82', 8);

   //--- Control row (y=30)
   Button("SHOW_L",    "Long",  12,  30, 50, 20, showLong  ? C'20,100,55'  : C'55,60,70', 8);
   Button("SHOW_S",    "Short", 66,  30, 50, 20, showShort ? C'130,45,45'  : C'55,60,70', 8);
   Button("SHOW_BOTH", "Both",  120, 30, 40, 20, C'55,75,100', 8);
   Button("HIDE_BOTH", "None",  164, 30, 40, 20, C'55,60,70',  8);
   Label("SCALE_L",    IntegerToString(panelScale) + "%", 260, 33, C'170,180,195', 8);
   Button("SIZE_DN",   "-",     302, 30, 22, 20, C'55,60,70', 8);
   Button("SIZE_UP",   "+",     328, 30, 22, 20, C'55,60,70', 8);

   //--- LONG section
   if(showLong)
   {
      Label("LONG_TITLE", "LONG / BUY", 12, 60, C'75,210,130', 10);
      Label("L_OPEN",  "Open", 12, 84);
      Edit ("L_ENTRY", DoubleToString(lng.entry, _Digits), 60, 81);
      Label("L_SL_L",  "SL",   12, 109);
      Edit ("L_SL",    DoubleToString(lng.sl, _Digits),    60, 106);
      Label("L_TP_L",  "TP",   12, 134);
      Edit ("L_TP",    DoubleToString(lng.tp, _Digits),    60, 131);
      Label("L_RISK",  "Risk: --", 12, 160, C'200,205,215');
      Label("L_LOT",   "Lots: --", 12, 180, C'75,210,130', 10);
      Button("BUY",    "BUY",  12, 206, 153, 30, C'20,130,75');
   }

   //--- SHORT section
   if(showShort)
   {
      Label("SHORT_TITLE", "SHORT / SELL", 190, 60, C'245,105,105', 10);
      Label("S_OPEN",  "Open", 190, 84);
      Edit ("S_ENTRY", DoubleToString(sht.entry, _Digits), 238, 81);
      Label("S_SL_L",  "SL",   190, 109);
      Edit ("S_SL",    DoubleToString(sht.sl, _Digits),    238, 106);
      Label("S_TP_L",  "TP",   190, 134);
      Edit ("S_TP",    DoubleToString(sht.tp, _Digits),    238, 131);
      Label("S_RISK",  "Risk: --", 190, 160, C'200,205,215');
      Label("S_LOT",   "Lots: --", 190, 180, C'245,105,105', 10);
      Button("SELL",   "SELL", 190, 206, 153, 30, C'170,55,55');
   }

   //--- Bottom section — mode / capital / status
   Label("MODE_L",    "Risk mode:", 12, bY + 10);
   Label("MODE_V",    mode == "FIXED" ? "Fixed dollar" : "Percentage", 95, bY + 10, C'255,210,100');
   Label("CAPITAL_L", "Capital: $" + DoubleToString(capital, 2), 12, bY + 30);
   Label("RISK_L",    "Risk: " + (mode == "FIXED"
                       ? "$" + DoubleToString(dollarRisk, 2)
                       : DoubleToString(riskPercent, 2) + "%"), 190, bY + 30);
   Label("STATUS",    "Drag lines or edit prices, then trade.", 12, bY + 56, C'170,180,195', 8);

   //--- Settings sub-panel
   if(settings)
   {
      int sY = bY + 84;
      Label("SET_HEAD",  "RISK SETTINGS", 12, sY, clrWhite, 9);
      Label("SET_MODE",  "Risk mode",     12, sY + 26);
      Button("MODE_FIXED",   "Fixed $",  88,  sY + 21, 75, 22, mode == "FIXED"   ? C'65,100,145' : C'55,60,70');
      Button("MODE_PERCENT", "Percent", 168, sY + 21, 75, 22, mode == "PERCENT" ? C'65,100,145' : C'55,60,70');
      Label("CAP_L",    "Capital ($)", 12, sY + 52);
      Edit ("SET_CAP",  DoubleToString(capital, 2), 88, sY + 48, 75);
      Label("RISK_SET_L", mode == "FIXED" ? "Dollar risk ($)" : "Risk (%)", 174, sY + 52);
      Edit ("SET_RISK", mode == "FIXED"
            ? DoubleToString(dollarRisk, 2)
            : DoubleToString(riskPercent, 2), 270, sY + 48, 77);
      Button("APPLY", "Apply", 270, sY + 21, 77, 22, C'35,105,75');
   }

   ChartRedraw();
}

//+------------------------------------------------------------------+
//|                   LIVE PREVIEW                                     |
//+------------------------------------------------------------------+
void Preview()
{
   Setup s; double r, g, v;

   if(showLong)
   {
      if(ReadSetup(true, s))
      {
         v = CalcLots(true, s, r, g);
         if(ObjectFind(0, Id("L_RISK")) >= 0)
            ObjectSetString(0, Id("L_RISK"), OBJPROP_TEXT, "Risk: $" + DoubleToString(r, 2));
         if(ObjectFind(0, Id("L_LOT")) >= 0)
            ObjectSetString(0, Id("L_LOT"), OBJPROP_TEXT, "Lots: " + (v > 0 ? DoubleToString(v, VolDigits()) : "--"));
      }
      else
      {
         if(ObjectFind(0, Id("L_RISK")) >= 0)
            ObjectSetString(0, Id("L_RISK"), OBJPROP_TEXT, "Risk: --");
         if(ObjectFind(0, Id("L_LOT")) >= 0)
            ObjectSetString(0, Id("L_LOT"), OBJPROP_TEXT, "Lots: --");
      }
   }

   if(showShort)
   {
      if(ReadSetup(false, s))
      {
         v = CalcLots(false, s, r, g);
         if(ObjectFind(0, Id("S_RISK")) >= 0)
            ObjectSetString(0, Id("S_RISK"), OBJPROP_TEXT, "Risk: $" + DoubleToString(r, 2));
         if(ObjectFind(0, Id("S_LOT")) >= 0)
            ObjectSetString(0, Id("S_LOT"), OBJPROP_TEXT, "Lots: " + (v > 0 ? DoubleToString(v, VolDigits()) : "--"));
      }
      else
      {
         if(ObjectFind(0, Id("S_RISK")) >= 0)
            ObjectSetString(0, Id("S_RISK"), OBJPROP_TEXT, "Risk: --");
         if(ObjectFind(0, Id("S_LOT")) >= 0)
            ObjectSetString(0, Id("S_LOT"), OBJPROP_TEXT, "Lots: --");
      }
   }

   ChartRedraw();
}

//+------------------------------------------------------------------+
//|                   TRADE EXECUTION                                  |
//+------------------------------------------------------------------+
bool Execute(bool isLong)
{
   if(busy) return false;
   busy = true;
   Setup s; double risk, reward;
   if(!ReadSetup(isLong, s))
   { Status("Invalid prices or SL/TP direction."); busy = false; return false; }
   double vol = CalcLots(isLong, s, risk, reward);
   if(vol <= 0)
   { Status("Cannot calculate volume: below broker min or invalid prices."); busy = false; return false; }
   if(risk > RiskAmount() + 0.01)
   { Status("Actual risk exceeds configured risk due to volume step."); busy = false; return false; }

   double bid = SymbolInfoDouble(_Symbol, SYMBOL_BID);
   double ask = SymbolInfoDouble(_Symbol, SYMBOL_ASK);
   double market = isLong ? ask : bid;
   bool   atMarket = MathAbs(s.entry - market) <= 2 * SymbolInfoDouble(_Symbol, SYMBOL_POINT);
   ENUM_ORDER_TYPE pending;
   if(isLong)  pending = (s.entry < ask) ? ORDER_TYPE_BUY_LIMIT  : ORDER_TYPE_BUY_STOP;
   else        pending = (s.entry > bid) ? ORDER_TYPE_SELL_LIMIT : ORDER_TYPE_SELL_STOP;

   string kind = atMarket ? "MARKET" :
                 (pending == ORDER_TYPE_BUY_LIMIT  ? "BUY LIMIT"  :
                  pending == ORDER_TYPE_BUY_STOP   ? "BUY STOP"   :
                  pending == ORDER_TYPE_SELL_LIMIT  ? "SELL LIMIT" : "SELL STOP");

   string msg = (isLong ? "LONG " : "SHORT ") + kind + "\n" + _Symbol +
                "\nEntry: "  + DoubleToString(s.entry, _Digits) +
                "\nSL: "     + DoubleToString(s.sl,    _Digits) +
                "\nTP: "     + DoubleToString(s.tp,    _Digits) +
                "\nVolume: " + DoubleToString(vol, VolDigits()) +
                "\nEst risk: $"   + DoubleToString(risk,   2) +
                "\nEst reward: $" + DoubleToString(reward, 2);

   if(ConfirmBeforeTrade && MessageBox(msg, "Confirm trade", MB_YESNO | MB_ICONQUESTION) != IDYES)
   { Status("Trade cancelled."); busy = false; return false; }

   trade.SetExpertMagicNumber(MagicNumber);
   trade.SetDeviationInPoints(SlippagePoints);
   trade.SetTypeFillingBySymbol(_Symbol);
   bool ok = false;
   if(atMarket)
   {
      if(isLong) ok = trade.Buy (vol, _Symbol, 0, s.sl, s.tp, "RiskTradePanel LONG");
      else       ok = trade.Sell(vol, _Symbol, 0, s.sl, s.tp, "RiskTradePanel SHORT");
   }
   else
   {
      if(pending == ORDER_TYPE_BUY_LIMIT)  ok = trade.BuyLimit (vol, s.entry, _Symbol, s.sl, s.tp, ORDER_TIME_GTC, 0, "RTP Buy Limit");
      if(pending == ORDER_TYPE_BUY_STOP)   ok = trade.BuyStop  (vol, s.entry, _Symbol, s.sl, s.tp, ORDER_TIME_GTC, 0, "RTP Buy Stop");
      if(pending == ORDER_TYPE_SELL_LIMIT)  ok = trade.SellLimit(vol, s.entry, _Symbol, s.sl, s.tp, ORDER_TIME_GTC, 0, "RTP Sell Limit");
      if(pending == ORDER_TYPE_SELL_STOP)   ok = trade.SellStop (vol, s.entry, _Symbol, s.sl, s.tp, ORDER_TIME_GTC, 0, "RTP Sell Stop");
   }
   Status(ok ? kind + " submitted." : ("Order rejected: " + trade.ResultRetcodeDescription()));
   busy = false;
   return ok;
}

void ApplySettings()
{
   capital = Read("SET_CAP", capital);
   double x = Read("SET_RISK", mode == "FIXED" ? dollarRisk : riskPercent);
   if(capital <= 0 || x <= 0 || (mode == "PERCENT" && x > 100))
   { Status("Invalid settings. Positive values required; risk% <= 100."); return; }
   if(mode == "FIXED") dollarRisk = x; else riskPercent = x;
   SaveSetups(); RemovePanel(); Draw(); Preview(); UpdateLines();
   Status("Settings applied.");
}

//+------------------------------------------------------------------+
//|                  Rebuild helper — called after any toggle          |
//+------------------------------------------------------------------+
void Rebuild()
{
   SaveSetups();
   RemovePanel();
   Draw();
   Preview();
   UpdateLines();
}

//+------------------------------------------------------------------+
//|                      EVENT HANDLERS                                |
//+------------------------------------------------------------------+
int OnInit()
{
   capital     = DefaultCapital;
   dollarRisk  = DefaultDollarRisk;
   riskPercent = DefaultRiskPercent;
   mode        = StartInFixedDollar ? "FIXED" : "PERCENT";
   panelScale  = MathMax(80, MathMin(150, DefaultPanelScale));
   curPanelX   = PanelX;
   curPanelY   = PanelY;

   double bid   = SymbolInfoDouble(_Symbol, SYMBOL_BID);
   double ask   = SymbolInfoDouble(_Symbol, SYMBOL_ASK);
   double mid   = (bid + ask) / 2.0;
   double point = SymbolInfoDouble(_Symbol, SYMBOL_POINT);
   if(mid <= 0) mid = 1;

   lng.entry = NormalizeDouble(mid,             _Digits);
   lng.sl    = NormalizeDouble(mid - 100*point, _Digits);
   lng.tp    = NormalizeDouble(mid + 200*point, _Digits);
   sht.entry = NormalizeDouble(mid,             _Digits);
   sht.sl    = NormalizeDouble(mid + 100*point, _Digits);
   sht.tp    = NormalizeDouble(mid - 200*point, _Digits);

   // Enable mouse-move events for panel dragging
   ChartSetInteger(0, CHART_EVENT_MOUSE_MOVE, true);

   Draw();
   Preview();
   UpdateLines();
   return INIT_SUCCEEDED;
}

void OnDeinit(const int reason)
{
   RemoveAll();
   // Restore chart mouse-scroll in case we disabled it
   ChartSetInteger(0, CHART_MOUSE_SCROLL, true);
}

void OnTick()
{
   Preview();
}

void OnChartEvent(const int id, const long &lp, const double &dp, const string &sp)
{
   //====================================================================
   // 1. PANEL DRAGGING (mouse-based, on title bar)
   //====================================================================
   if(id == CHARTEVENT_MOUSE_MOVE)
   {
      int mx    = (int)lp;
      int my    = (int)dp;
      int flags = (int)StringToInteger(sp);
      bool leftDown = (flags & 1) != 0;

      // Begin pending drag if clicking in title bar
      if(leftDown && !panelDragging && !panelDragPending)
      {
         if(mx >= curPanelX && mx <= curPanelX + S(BASEW) &&
            my >= curPanelY && my <= curPanelY + S(25))
         {
            panelDragPending = true;
            pendingDragX = mx;
            pendingDragY = my;
            dragOffsetX  = mx - curPanelX;
            dragOffsetY  = my - curPanelY;
         }
      }

      // Promote to actual drag after 4-pixel threshold
      if(panelDragPending && leftDown && !panelDragging)
      {
         if(MathAbs(mx - pendingDragX) > 4 || MathAbs(my - pendingDragY) > 4)
         {
            panelDragging    = true;
            panelDragPending = false;
            ChartSetInteger(0, CHART_MOUSE_SCROLL, false);
         }
      }

      // While dragging — translate panel
      if(panelDragging)
      {
         if(leftDown)
         {
            int newX = mx - dragOffsetX;
            int newY = my - dragOffsetY;
            if(newX < 0) newX = 0;
            if(newY < 0) newY = 0;
            MovePanel(newX, newY);
         }
         else
         {
            panelDragging    = false;
            panelDragPending = false;
            ChartSetInteger(0, CHART_MOUSE_SCROLL, true);
         }
      }

      // Cancel pending drag if mouse released
      if(!leftDown) panelDragPending = false;
   }

   //====================================================================
   // 2. CHART-LINE DRAGGED — sync price back to edit fields
   //====================================================================
   if(id == CHARTEVENT_OBJECT_DRAG)
   {
      if(StringFind(sp, LP) == 0)
      {
         SyncFromLine(sp);
         Preview();
         UpdateLines();  // refresh fill zones to match new line position
      }
   }

   //====================================================================
   // 3. BUTTON / OBJECT CLICKS
   //====================================================================
   if(id == CHARTEVENT_OBJECT_CLICK)
   {
      // Trade execution
      if(sp == Id("BUY"))  Execute(true);
      if(sp == Id("SELL")) Execute(false);

      // Settings toggle
      if(sp == Id("SETTINGS"))
      {
         settings = !settings;
         Rebuild();
      }

      // Risk mode toggle (inside settings)
      if(sp == Id("MODE_FIXED"))
      {
         mode = "FIXED";
         Rebuild();
      }
      if(sp == Id("MODE_PERCENT"))
      {
         mode = "PERCENT";
         Rebuild();
      }

      // Apply settings
      if(sp == Id("APPLY")) ApplySettings();

      //--- Visibility toggles
      if(sp == Id("SHOW_L"))
      {
         showLong = !showLong;
         Rebuild();
      }
      if(sp == Id("SHOW_S"))
      {
         showShort = !showShort;
         Rebuild();
      }
      if(sp == Id("SHOW_BOTH"))
      {
         showLong = true; showShort = true;
         Rebuild();
      }
      if(sp == Id("HIDE_BOTH"))
      {
         showLong = false; showShort = false;
         Rebuild();
      }

      //--- Panel scale
      if(sp == Id("SIZE_DN"))
      {
         if(panelScale > 80)
         { panelScale -= 10; Rebuild(); }
      }
      if(sp == Id("SIZE_UP"))
      {
         if(panelScale < 150)
         { panelScale += 10; Rebuild(); }
      }

      // Reset button press-state so it pops back up
      if(ObjectFind(0, sp) >= 0)
         ObjectSetInteger(0, sp, OBJPROP_STATE, false);
   }

   //====================================================================
   // 4. EDIT-FIELD CHANGED — recalculate & update lines
   //====================================================================
   if(id == CHARTEVENT_OBJECT_ENDEDIT)
   {
      SaveSetups();
      Preview();
      UpdateLines();
   }
}
//+------------------------------------------------------------------+
