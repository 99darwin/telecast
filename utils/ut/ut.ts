import { UTApi } from "uploadthing/server";
import { botToken } from "../../config";
import bot from "../../bot";


const utapi = new UTApi();

async function uploadImageFromTelegram(fileId: string): Promise<string> {
  try {
    // Get file info from Telegram
    const fileInfo = await bot.api.getFile(fileId);
    const fileUrl = `https://api.telegram.org/file/bot${botToken}/${fileInfo.file_path}`;
    
    // Download the file
    const response = await fetch(fileUrl);
    const buffer = await response.arrayBuffer();
    
    // Create a file-like object with a name property
    const fileName = fileInfo.file_path?.split('/').pop() || `image_${Date.now()}.jpg`;
    
    // Upload to UploadThing - using the correct format
    const uploadedFiles = await utapi.uploadFiles([
      new File([buffer], fileName, { type: "image/jpeg" })
    ]);
    
    // Check if upload was successful and return the URL
    if (uploadedFiles[0]?.data) {
      return uploadedFiles[0].data.ufsUrl;
    }
    
    throw new Error("Failed to upload image");
  } catch (error) {
    console.error("Error uploading image:", error);
    throw new Error("Failed to upload image");
  }
}

export { uploadImageFromTelegram };