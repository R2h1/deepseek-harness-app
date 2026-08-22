// Create (or recreate) a .lnk with the AppUserModelID property set.
using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Runtime.InteropServices.ComTypes;

public class MakeLnkAumid
{
    [ComImport, Guid("00021401-0000-0000-C000-000000000046"), ClassInterface(ClassInterfaceType.None)]
    public class CShellLink { }

    [ComImport, InterfaceType(ComInterfaceType.InterfaceIsIUnknown), Guid("000214F9-0000-0000-C000-000000000046")]
    public interface IShellLinkW
    {
        void GetPath([Out, MarshalAs(UnmanagedType.LPWStr)] System.Text.StringBuilder pszFile, int cch, IntPtr pfd, uint fFlags);
        void GetIDList(out IntPtr ppidl);
        void SetIDList(IntPtr pidl);
        void GetDescription([Out, MarshalAs(UnmanagedType.LPWStr)] System.Text.StringBuilder pszName, int cch);
        void SetDescription([MarshalAs(UnmanagedType.LPWStr)] string pszName);
        void GetWorkingDirectory([Out, MarshalAs(UnmanagedType.LPWStr)] System.Text.StringBuilder pszDir, int cch);
        void SetWorkingDirectory([MarshalAs(UnmanagedType.LPWStr)] string pszDir);
        void GetArguments([Out, MarshalAs(UnmanagedType.LPWStr)] System.Text.StringBuilder pszArgs, int cch);
        void SetArguments([MarshalAs(UnmanagedType.LPWStr)] string pszArgs);
        void GetHotkey(out short pwHotkey);
        void SetHotkey(short wHotkey);
        void GetShowCmd(out uint piShowCmd);
        void SetShowCmd(uint iShowCmd);
        void GetIconLocation([Out, MarshalAs(UnmanagedType.LPWStr)] System.Text.StringBuilder pszIconPath, int cch, out int piIcon);
        void SetIconLocation([MarshalAs(UnmanagedType.LPWStr)] string pszIconPath, int iIcon);
        void SetRelativePath([MarshalAs(UnmanagedType.LPWStr)] string pszPathRel, uint dwReserved);
        void Resolve(IntPtr hwnd, uint fFlags);
        void SetPath([MarshalAs(UnmanagedType.LPWStr)] string pszFile);
    }

    [ComImport, InterfaceType(ComInterfaceType.InterfaceIsIUnknown), Guid("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99")]
    public interface IPropertyStore
    {
        int GetCount(out uint cProps);
        int GetAt(uint iProp, out PropertyKey pkey);
        int GetValue(ref PropertyKey key, out PropVariant pv);
        int SetValue(ref PropertyKey key, ref PropVariant pv);
        int Commit();
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct PropertyKey
    {
        public Guid fmtid;
        public uint pid;
        public PropertyKey(Guid f, uint p) { fmtid = f; pid = p; }
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct PropVariant
    {
        public ushort vt;
        public ushort wReserved1, wReserved2, wReserved3;
        public IntPtr data1, data2, data3, data4;
        public static PropVariant FromString(string s)
        {
            PropVariant pv = new PropVariant();
            pv.vt = 31;
            pv.data1 = Marshal.StringToCoTaskMemUni(s);
            return pv;
        }
    }

    [DllImport("ole32.dll")]
    static extern void CoTaskMemFree(IntPtr pv);

    public static int Main(string[] args)
    {
        if (args.Length < 3) { Console.Error.WriteLine("usage: MakeLnkAumid <shortcut.lnk> <targetExe> <appUserModelId> [iconExe,iconIdx]"); return 2; }
        string path = args[0], target = args[1], aumid = args[2];
        string icon = args.Length > 3 ? args[3] : target;
        int iconIdx = args.Length > 4 ? int.Parse(args[4]) : 0;
        try
        {
            var link = (IShellLinkW)new CShellLink();
            link.SetPath(target);
            link.SetIconLocation(icon, iconIdx);
            var store = (IPropertyStore)link;
            PropertyKey pkey = new PropertyKey(new Guid("9F4C2855-9F79-4B39-A8D0-E1D42DE1D5F3"), 5);
            PropVariant pv = PropVariant.FromString(aumid);
            int hr = store.SetValue(ref pkey, ref pv);
            CoTaskMemFree(pv.data1);
            if (hr != 0) { Console.Error.WriteLine("SetValue 0x" + hr.ToString("X")); return 4; }
            store.Commit();
            var persist = (IPersistFile)link;
            persist.Save(path, true);
            Console.WriteLine("created " + path + " -> " + target + " AUMID=" + aumid);
            return 0;
        }
        catch (Exception ex) { Console.Error.WriteLine("error: " + ex.Message); return 6; }
    }
}
