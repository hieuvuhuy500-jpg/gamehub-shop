# GTN GAMING SHOP

## Chạy local
1. Cài Node.js LTS và mở thư mục `gamehub-shop` trong VS Code.
2. Chạy `npm install`.
3. Sao chép `.env.example` thành `.env`; tự đặt `ADMIN_EMAIL`, `ADMIN_PASSWORD` và `SESSION_SECRET`.
4. Chạy `npm run dev` hoặc `npm start`.
5. Mở `http://localhost:3000`.

Chế độ `npm run dev` bỏ qua thư mục dữ liệu để Nodemon không khởi động lại máy chủ khi có đơn hàng hoặc sản phẩm mới.
Lần đầu chạy, ứng dụng tạo tài khoản quản trị từ `ADMIN_EMAIL` và `ADMIN_PASSWORD`. Admin và khách đăng nhập tại `/dang-nhap`; tài khoản có quyền `admin` sẽ tự chuyển vào `/admin`, còn khách được chuyển đến trang tài khoản. Khu vực Admin không hiển thị trên giao diện khách và được bảo vệ theo quyền tài khoản. Không gửi nội dung `.env` hoặc khóa bí mật qua chat.
Phiên đăng nhập được mã hóa và lưu trong `data/sessions`, được ghi nhớ tối đa 30 ngày và gia hạn khi sử dụng; đăng xuất sẽ kết thúc phiên. Nếu `SESSION_SECRET` chưa được đặt ở môi trường local, ứng dụng tạo khóa ổn định trong `data/.session-secret`. Giữ nguyên thư mục `data` và `SESSION_SECRET` để các phiên tiếp tục hoạt động sau khi khởi động lại; không dùng tùy chọn ghi nhớ trên thiết bị dùng chung.

## Đưa website lên Internet bằng Render
Render chạy website trên máy chủ đám mây nên khách có thể truy cập khi máy tính cá nhân tắt. Tệp `render.yaml` cấu hình web service trả phí cùng ổ đĩa bền vững 1 GB tại `/var/data`, nơi lưu cơ sở dữ liệu JSON và phiên đăng nhập. Render tự tạo `SESSION_SECRET` và cấp URL `onrender.com`; gói trả phí và ổ đĩa sẽ phát sinh phí hằng tháng.
1. Tạo kho GitHub mới và đưa các tệp trong thư mục `gamehub-shop` lên kho. Không đưa `.env`, `node_modules` hoặc dữ liệu riêng trong `data` lên GitHub.
2. Trong Render, chọn **New > Blueprint**, kết nối kho GitHub và triển khai `render.yaml`. Kiểm tra gói trả phí và chi phí trong Dashboard trước khi xác nhận; ổ đĩa chỉ dùng được với web service trả phí.
3. Khi Render hỏi biến môi trường, nhập `ADMIN_EMAIL`, `ADMIN_PASSWORD` mạnh và `DELIVERY_ENCRYPTION_KEY` gồm 64 ký tự hex. Tạo khóa mới bằng lệnh `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`; giữ khóa an toàn. Nếu chuyển dữ liệu kho đã mã hóa từ máy cá nhân, phải dùng đúng khóa `DELIVERY_ENCRYPTION_KEY` cũ.
4. Chờ trạng thái triển khai thành công rồi mở URL `onrender.com` do Render cấp. Website vẫn hoạt động khi máy tính cá nhân tắt.

Ổ đĩa giữ dữ liệu qua các lần khởi động và triển khai, nhưng dữ liệu trên máy cá nhân không tự được chuyển lên hosting. Không đưa `data/db.json`, `.env` hoặc khóa bí mật lên GitHub; cần chuyển dữ liệu riêng bằng phương thức bảo mật và giữ nguyên khóa mã hóa để đọc kho hàng cũ. Ổ đĩa chỉ gắn với một instance và có thể gây gián đoạn ngắn khi triển khai. Ứng dụng vẫn dùng JSON và phù hợp một instance; trước khi nhận tiền thật cần cấu hình thanh toán HTTPS, sao lưu/khôi phục và kiểm thử đầy đủ.

## Chuẩn bị VPS Ubuntu và HTTPS cho khách
Tên miền `hvv.com` hiện mới là tên dự kiến; VPS chưa được thuê và website chưa được đưa lên Internet. Khi đã sở hữu domain và VPS Ubuntu 24.04:
1. Trỏ bản ghi DNS `A` cho `hvv.com` và `www.hvv.com` về IPv4 của VPS; chờ DNS cập nhật.
2. Cài Node.js LTS, Nginx và Certbot trên VPS. Triển khai mã nguồn vào `/opt/gamehub-shop`, cài package và tạo file `.env` riêng trên VPS.
3. Trong `.env` production, đặt `NODE_ENV=production`, `PORT=3000`, email/mật khẩu admin mạnh, `SESSION_SECRET` tối thiểu 32 ký tự và `DELIVERY_ENCRYPTION_KEY` 64 ký tự hex. Không chép `.env` hoặc `data/db.json` lên kho mã nguồn.
4. Chạy Node bằng `systemd`, chỉ bind ứng dụng ở `127.0.0.1:3000`, rồi cấu hình Nginx làm reverse proxy cho `hvv.com` và `www.hvv.com`.
5. Mở firewall VPS cho SSH, HTTP (80) và HTTPS (443), sau đó cấp chứng chỉ TLS bằng Certbot. Ứng dụng production tin cậy một reverse proxy để HTTPS session cookie hoạt động.
6. Trước khi nhận tiền thật, chuyển dữ liệu JSON sang cơ sở dữ liệu production phù hợp, bật sao lưu và kiểm thử khôi phục. Chỉ cấu hình VNPay sau khi có tài khoản merchant và IPN/Return URL HTTPS hoạt động.

Không chia sẻ mật khẩu SSH, khóa riêng, `.env` hoặc thông tin merchant qua chat. Chưa có VPS/domain được cấp phát nên hiện chưa tồn tại URL công khai để gửi khách.

## Nạp tiền VNPay
- Đăng ký tài khoản merchant VNPay và cấu hình `VNPAY_TMN_CODE`, `VNPAY_HASH_SECRET`, `VNPAY_PAYMENT_URL`, `VNPAY_RETURN_URL`, `VNPAY_IPN_URL`.
- Chỉ dùng URL thanh toán chính thức do VNPay cấp; môi trường production không dùng sandbox.
- Return URL và IPN URL phải là HTTPS công khai. IPN endpoint là `/api/vnpay/ipn`; trang kết quả là `/nap-tien/ket-qua`.
- Ví chỉ được cộng khi IPN có chữ ký hợp lệ, mã merchant và số tiền khớp, và giao dịch chưa được xử lý. Trang quản trị không thể tự xác nhận nạp tiền.
- Khi thiếu cấu hình, nút thanh toán bị tắt và hệ thống không tự tạo số dư.
- Website hiện chỉ chạy local. VNPay không thể gọi IPN đến `localhost`; cần domain/hosting có HTTPS (hoặc tunnel HTTPS chỉ để thử nghiệm) và tài khoản merchant trước khi kiểm tra thanh toán.
- Thẻ cào cần cổng/API chính thức và hiện vẫn bị khóa. Chuyển khoản ngân hàng chỉ mở sau khi SePay, thông tin nhận tiền và webhook HTTPS đã được cấu hình. Không nhập mã thẻ trực tiếp hoặc cộng số dư thủ công khi chưa đối soát giao dịch.

## Chuyển khoản tự động qua SePay
- SePay là lựa chọn webhook ngân hàng; xem [hướng dẫn đăng ký](https://docs.sepay.vn/dang-ky-sepay.html) và [tích hợp webhook](https://docs.sepay.vn/tich-hop-webhooks.html), sau đó liên kết tài khoản ngân hàng nhận tiền. Dịch vụ có thể tính phí theo gói.
- Website cần chạy trên domain HTTPS công khai. Đặt các giá trị `SEPAY_BANK_CODE`, `SEPAY_ACCOUNT_NUMBER`, `SEPAY_ACCOUNT_NAME`, `SEPAY_WEBHOOK_SECRET` và `SEPAY_WEBHOOK_URL` trong `.env`. URL phải là `https://<domain>/api/sepay/webhook`.
- Tạo khóa ngẫu nhiên dài ít nhất 32 ký tự bằng `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`. Dùng đúng khóa đó cho `SEPAY_WEBHOOK_SECRET` và cấu hình xác thực **HMAC-SHA256** của SePay.
- Trong SePay, tạo webhook chỉ nhận giao dịch tiền vào, chọn đúng tài khoản ngân hàng, URL ở trên và xác thực **HMAC-SHA256**. Không chọn chế độ không xác thực hoặc chỉ dùng cho môi trường thật.
- Khi cấu hình hợp lệ, khách tạo lệnh chuyển khoản và nhận QR/mã nội dung riêng. Máy chủ chỉ cộng ví khi HMAC hợp lệ và webhook khớp tài khoản nhận, nội dung, số tiền và mã giao dịch chưa xử lý.
- Kiểm tra ban đầu bằng Test Mode của SePay; chưa nhận tiền thật đến khi đã triển khai HTTPS công khai, cấu hình tài khoản thật và kiểm tra một giao dịch nhỏ.

Thẻ cào vẫn bị khóa. Chỉ mở sau khi có tài khoản tại nhà cung cấp thẻ cào chính thức và tài liệu API/đối soát được xác minh; không thu thập serial/PIN trực tiếp trên website.

## Kho hàng và giao tự động
- Thêm sản phẩm trong trang quản trị và nhập từng tài khoản theo dòng `tên đăng nhập|mật khẩu`.
- Nếu tạo sản phẩm trùng tên và danh mục (không phân biệt hoa thường, dấu tiếng Việt hoặc khoảng trắng thừa), tài khoản mới được cộng vào kho hiện có; tài khoản và thông tin sản phẩm cũ được giữ nguyên. Dùng biểu mẫu chỉnh sửa sản phẩm để thay đổi giá, ảnh hoặc mô tả.
- Nhập cùng tên game cho các sản phẩm cùng danh mục; chọn danh mục trong Admin để lọc và quản lý riêng. Danh mục Free Fire và Roblox có sẵn; có thể nhập sản phẩm vào hai danh mục này ngay. Khách xem sản phẩm theo từng trang `/game/<tên-game>`, liên kết từ các danh mục trên cửa hàng.
- Tạo khóa mã hóa 32 byte bằng lệnh `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` rồi đặt vào `DELIVERY_ENCRYPTION_KEY`.
- Thông tin nhập kho được mã hóa AES-256-GCM trong dữ liệu và chỉ hiển thị cho người mua sau khi thanh toán bằng ví thành công. Không dùng chung mật khẩu, sao lưu `.env` an toàn và chỉ bán tài khoản có quyền phân phối.
- Sản phẩm cũ không có thông tin giao hàng được coi là hết hàng; chúng không tự bán bằng số lượng mẫu cũ. Xóa hoặc sửa dữ liệu cũ sau khi đã sao lưu.

## Trợ lý AI và giao diện
- Thêm `OPENAI_API_KEY` vào `.env`; có thể đổi model bằng `OPENAI_MODEL`. Khóa chỉ được đọc ở máy chủ.
- Không gửi mật khẩu, mã xác thực, thông tin ngân hàng hoặc khóa API vào hộp chat.
- Website hỗ trợ điện thoại/máy tính và lưu tùy chọn sáng/tối trên trình duyệt.

## Trước khi mở bán công khai
Ứng dụng vẫn lưu dữ liệu nghiệp vụ trong JSON và session trong các tệp mã hóa; disk bền vững giúp giữ các tệp này qua lần khởi động lại nhưng không biến JSON thành cơ sở dữ liệu production. Đây chỉ phù hợp một instance, không hỗ trợ mở rộng nhiều tiến trình. Trước khi nhận tiền thật, cần chuyển dữ liệu sang cơ sở dữ liệu production phù hợp, cấu hình sao lưu, rà soát bảo mật và hoàn tất kiểm thử với tài khoản VNPay của bạn. Không dùng giao dịch sandbox cho khách thật.
