## 📝 Description
<!-- อธิบายว่า PR นี้ทำอะไร -->

## 🎯 Type of Change
- [ ] 🐛 Bug fix (non-breaking change)
- [ ] ✨ New feature (non-breaking change)
- [ ] 💥 Breaking change (fix/feature ที่ทำให้ของเดิมเสีย)
- [ ] 📝 Documentation
- [ ] ♻️  Refactor (ไม่เปลี่ยน behavior)
- [ ] ⚡ Performance improvement

## 📋 Module ที่แตะ
- [ ] 00_App.gs
- [ ] 01_Config.gs *(breaking change ต้องระวัง)*
- [ ] 02_Schema.gs *(breaking change ต้องระวัง)*
- [ ] 03-21: ________________
- [ ] 22_WebApp.gs
- [ ] 24_PipelineManager.gs
- [ ] 99_Legacy.gs (deprecated functions)

## ✅ 16 Immutable Laws Checklist
- [ ] **Law 1**: ไม่มี Hardcoded Index (ใช้ `XXX_IDX.NAME` แทน `row[N]`)
- [ ] **Law 2**: Single Writer Pattern (M_ALIAS เขียนโดย 10/21 เท่านั้น)
- [ ] **Law 3**: Batch Operations (ใช้ `setValues()` ไม่ใช่ `setValue()` ในลูป)
- [ ] **Law 4**: ใช้ Index จาก `01_Config`
- [ ] **Law 5**: Entry Point มี `try-catch`
- [ ] **Law 6**: Log error ด้วย `logError('Module', msg, err)`
- [ ] **Law 13**: ไม่มี Silent Fail
- [ ] **Law 16**: ไม่มี Secret ใน Cell (API Key เก็บใน Script Properties)

## 🧪 Testing
<!-- ทดสอบยังไงบ้าง -->
- [ ] ทดสอบด้วยตัวเอง
- [ ] ทดสอบในโหมด [CMD: PREDEPLOY]
- [ ] ตรวจสอบ SYS_LOG ไม่มี error

## 📸 Screenshots / Evidence
<!-- แนบรูปหรือ log -->

## 🔗 Related Issues
<!-- เชื่อมโยง issue เช่น Fixes #123 -->

## 🚀 Deployment Notes
<!-- มีอะไรต้องทำเพิ่มหลัง deploy ไหม เช่น ตั้งค่า Script Property ใหม่ -->